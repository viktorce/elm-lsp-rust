//! Field operations for the Elm workspace.
//!
//! Contains functions for renaming and removing fields and finding their
//! uses across the workspace. Which record a use belongs to comes from the
//! type inference of `field_inference`.

use std::collections::HashMap;
use std::path::PathBuf;
use tower_lsp::lsp_types::*;

use crate::binder::BoundSymbolKind;
use crate::field_inference::{
    field_references, remove_field, rename_field, FieldEdit, FieldRemoval, SourceModule,
};

use super::{FieldInfo, FieldUsage, FieldUsageType, RemoveFieldResult, SymbolReference, Workspace};

impl Workspace {
    /// Prepare to remove a field: the alias, the field, all the fields of the
    /// alias and the uses that the removal changes. `None` where no field of
    /// a type alias stands at the position, and an error that says why where
    /// the removal is not possible.
    #[allow(clippy::type_complexity)]
    pub fn prepare_remove_field(
        &self,
        uri: &Url,
        line: u32,
        character: u32,
    ) -> Option<Result<(String, String, Vec<String>, Vec<FieldUsage>), String>> {
        let tree = self.type_checker.get_tree(uri.as_str())?;
        let content = self.type_checker.get_source(uri.as_str())?;
        let point = tree_sitter::Point::new(line as usize, character as usize);
        let node = tree.root_node().descendant_for_point_range(point, point)?;
        let (type_alias_name, field_name, all_fields) =
            self.find_field_at_position(node, content)?;
        crate::field_inference::field_name_at(node, content)?;
        if let Some(variable) = type_variable_left_unused(node, content) {
            return Some(Err(format!(
                "Removing the field `{}` is not possible: it is the only field of {} at {}:{}:{} that uses the type variable `{}`, and the compiler does not let an alias keep a type variable that it does not use. Nothing was changed.",
                field_name,
                type_alias_name,
                uri.to_file_path()
                    .map(|path| path.display().to_string())
                    .unwrap_or_else(|_| uri.to_string()),
                line + 1,
                character + 1,
                variable
            )));
        }

        let removal = self.with_project_modules(|modules, dirs| {
            remove_field(modules, dirs, uri.as_str(), point)
        })?;
        Some(removal.map(|removal| {
            let usages = self.removal_usages(&field_name, &removal);
            (type_alias_name, field_name, all_fields, usages)
        }))
    }

    /// What removing the field does at each of its uses
    fn removal_usages(&self, field_name: &str, removal: &FieldRemoval) -> Vec<FieldUsage> {
        let todo = format!("(Debug.todo \"FIXME: Field Removal: {}\")", field_name);
        let mut usages = Vec::new();
        let bound = removal.bound.iter().map(|edit| (edit, true));
        for (edit, is_bound) in removal.fields.iter().map(|edit| (edit, false)).chain(bound) {
            let (Some(tree), Some(source)) = (
                self.type_checker.get_tree(&edit.uri),
                self.type_checker.get_source(&edit.uri),
            ) else {
                continue;
            };
            let start = tree_sitter::Point::new(
                edit.range.start.line as usize,
                edit.range.start.character as usize,
            );
            let Some(node) = tree.root_node().descendant_for_point_range(start, start) else {
                continue;
            };
            let removed = if is_bound {
                Some((FieldUsageType::PatternVariable, edit.range, todo.clone()))
            } else {
                removal_at(node, source, field_name)
            };
            let Some((usage_type, full_range, replacement)) = removed else {
                continue;
            };
            let module_name = Url::parse(&edit.uri)
                .ok()
                .and_then(|uri| uri.to_file_path().ok())
                .and_then(|path| {
                    self.find_module_by_path(&path)
                        .map(|m| m.module_name.clone())
                })
                .unwrap_or_default();
            usages.push(FieldUsage {
                uri: edit.uri.clone(),
                line: edit.range.start.line,
                character: edit.range.start.character,
                usage_type,
                context: source
                    .lines()
                    .nth(edit.range.start.line as usize)
                    .map(|l| l.trim().to_string())
                    .unwrap_or_default(),
                module_name,
                full_range: Some(full_range),
                replacement_text: Some(replacement),
            });
        }
        usages
    }

    /// Find the type alias name, field name, and all fields at a position
    fn find_field_at_position(
        &self,
        node: tree_sitter::Node,
        content: &str,
    ) -> Option<(String, String, Vec<String>)> {
        // Walk up to find field_type and type_alias_declaration
        let mut current = Some(node);
        let mut field_name = None;

        while let Some(n) = current {
            if n.kind() == "lower_case_identifier" && field_name.is_none() {
                field_name = Some(content[n.byte_range()].to_string());
            }

            if n.kind() == "type_alias_declaration" {
                // Found the type alias
                let type_name = n
                    .child_by_field_name("name")
                    .map(|name_node| content[name_node.byte_range()].to_string())?;

                // Find all fields in this type
                let mut all_fields = Vec::new();
                let mut cursor = n.walk();
                Self::collect_fields_in_type(&mut cursor, content, &mut all_fields);

                return Some((type_name, field_name?, all_fields));
            }

            current = n.parent();
        }

        None
    }

    /// Collect all field names in a type alias
    fn collect_fields_in_type(
        cursor: &mut tree_sitter::TreeCursor,
        content: &str,
        fields: &mut Vec<String>,
    ) {
        loop {
            let node = cursor.node();
            if node.kind() == "field_type" {
                // Get the field name (first lower_case_identifier child)
                for i in 0..node.child_count() {
                    if let Some(child) = node.child(i) {
                        if child.kind() == "lower_case_identifier" {
                            fields.push(content[child.byte_range()].to_string());
                            break;
                        }
                    }
                }
            }

            if cursor.goto_first_child() {
                Self::collect_fields_in_type(cursor, content, fields);
                cursor.goto_parent();
            }

            if !cursor.goto_next_sibling() {
                break;
            }
        }
    }

    /// The edits that remove a field from a type alias, from the uses that
    /// `prepare_remove_field` found
    pub fn remove_field(
        &self,
        type_name: &str,
        field_name: &str,
        total_fields: usize,
        usages: &[FieldUsage],
    ) -> RemoveFieldResult {
        if total_fields <= 1 {
            return RemoveFieldResult::error("Cannot remove the only field from a type alias");
        }

        let mut by_file: HashMap<&str, Vec<&FieldUsage>> = HashMap::new();
        for usage in usages {
            by_file.entry(usage.uri.as_str()).or_default().push(usage);
        }
        let mut changes: HashMap<Url, Vec<TextEdit>> = HashMap::new();
        let mut counts: HashMap<FieldUsageType, usize> = HashMap::new();
        for (uri, mine) in by_file {
            let Ok(url) = Url::parse(uri) else {
                continue;
            };
            let edits = changes.entry(url).or_default();
            for usage in &mine {
                let (Some(range), Some(text)) = (usage.full_range, &usage.replacement_text) else {
                    continue;
                };
                // A use inside the stretch that another one removes goes with it,
                // as the access in `{ r | name = r.name ++ "!" }`
                let inside = mine.iter().any(|other| {
                    other
                        .full_range
                        .is_some_and(|outer| outer != range && contains(&outer, &range))
                });
                if inside {
                    continue;
                }
                *counts.entry(usage.usage_type).or_default() += 1;
                edits.push(TextEdit {
                    range,
                    new_text: text.clone(),
                });
            }
        }
        Self::sort_edits_reverse(&mut changes);

        let count = |usage_type| counts.get(&usage_type).copied().unwrap_or(0);
        let mut parts = vec![format!(
            "Removed field '{}' from '{}'",
            field_name, type_name
        )];
        for (usage_type, what) in [
            (
                FieldUsageType::FieldAccess,
                "replaced {} field access(es) with Debug.todo",
            ),
            (
                FieldUsageType::FieldAccessor,
                "replaced {} field accessor(s) with Debug.todo",
            ),
            (
                FieldUsageType::PatternVariable,
                "replaced {} use(s) of the variable that a record pattern binds with Debug.todo",
            ),
            (
                FieldUsageType::RecordPattern,
                "removed from {} record pattern(s)",
            ),
            (
                FieldUsageType::RecordLiteral,
                "removed from {} record literal(s)",
            ),
            (
                FieldUsageType::RecordUpdate,
                "removed from {} record update(s)",
            ),
        ] {
            if count(usage_type) > 0 {
                parts.push(what.replace("{}", &count(usage_type).to_string()));
            }
        }
        let message = if parts.len() == 1 {
            parts[0].clone()
        } else {
            format!("{}, {}", parts[0], parts[1..].join(", "))
        };

        RemoveFieldResult::success(&message, changes)
    }

    /// Get field info at a given position in a file
    pub fn get_field_at_position(
        &self,
        uri: &Url,
        position: Position,
        content: &str,
    ) -> Option<FieldInfo> {
        // Use the cached tree from the type checker to ensure node IDs match
        let tree = match self.type_checker.get_tree(uri.as_str()) {
            Some(t) => t,
            None => {
                return None;
            }
        };
        let root = tree.root_node();

        // Find the node at the position
        let point = tree_sitter::Point::new(position.line as usize, position.character as usize);
        let node = match Self::find_node_at_point(root, point) {
            Some(n) => n,
            None => {
                return None;
            }
        };

        // Check if this is a field reference
        let field_def = self
            .type_checker
            .find_field_definition(uri.as_str(), node, content);
        let field_def = field_def?;

        // Calculate the range for just the field name
        let range = Range {
            start: Position::new(
                node.start_position().row as u32,
                node.start_position().column as u32,
            ),
            end: Position::new(
                node.end_position().row as u32,
                node.end_position().column as u32,
            ),
        };

        Some(FieldInfo {
            name: field_def.name.clone(),
            range,
            definition: field_def,
        })
    }

    /// The field that the identifier at `position` names, with its range. It
    /// says what stands there and nothing about the record it belongs to.
    pub fn field_name_at_position(&self, uri: &Url, position: Position) -> Option<(String, Range)> {
        let tree = self.type_checker.get_tree(uri.as_str())?;
        let source = self.type_checker.get_source(uri.as_str())?;
        let point = tree_sitter::Point::new(position.line as usize, position.character as usize);
        let node = tree.root_node().descendant_for_point_range(point, point)?;
        let name = crate::field_inference::field_name_at(node, source)?;
        let range = Range {
            start: Position::new(
                node.start_position().row as u32,
                node.start_position().column as u32,
            ),
            end: Position::new(
                node.end_position().row as u32,
                node.end_position().column as u32,
            ),
        };
        Some((name.to_string(), range))
    }

    /// The directories of the packages that elm.json names, as the cache of
    /// the compiler that builds the project holds them now. A build after the
    /// server started can have brought them, so they are looked for at each call.
    fn package_dirs(&self) -> Vec<PathBuf> {
        let Some(json) = self
            .elm_json_text
            .as_deref()
            .and_then(|text| serde_json::from_str::<serde_json::Value>(text).ok())
        else {
            return Vec::new();
        };
        let caches = Self::package_caches(&json);
        let mut dirs = Vec::new();
        for section in ["dependencies", "test-dependencies"] {
            let Some(listed) = json.get(section) else {
                continue;
            };
            // An application lists direct and indirect ones, a package one list of ranges
            let groups: Vec<&serde_json::Value> =
                match (listed.get("direct"), listed.get("indirect")) {
                    (None, None) => vec![listed],
                    (direct, indirect) => direct.into_iter().chain(indirect).collect(),
                };
            for (name, version) in groups.iter().filter_map(|g| g.as_object()).flatten() {
                dirs.extend(super::package_in(
                    &caches,
                    name,
                    version.as_str().unwrap_or(""),
                ));
            }
        }
        dirs.sort();
        dirs.dedup();
        dirs
    }

    /// The project's modules as the index holds them and the directories of
    /// its packages, which the field inference reads
    fn with_project_modules<T>(&self, run: impl FnOnce(&[SourceModule], &[PathBuf]) -> T) -> T {
        let uris: Vec<String> = self
            .iter_non_evergreen_modules()
            .map(|(_module, module_uri)| module_uri.to_string())
            .collect();
        let modules: Vec<SourceModule> = uris
            .iter()
            .filter_map(|module_uri| {
                Some(SourceModule {
                    uri: module_uri,
                    source: self.type_checker.get_source(module_uri)?,
                    tree: self.type_checker.get_tree(module_uri)?,
                })
            })
            .collect();
        run(&modules, &self.package_dirs())
    }

    /// The edits that rename the field at `position` to `new_name`, found by
    /// type inference over the project. `None` where no field stands there,
    /// and an error that says why where the rename is not possible.
    pub fn rename_field_at(
        &self,
        uri: &Url,
        position: Position,
        new_name: &str,
    ) -> Option<Result<Vec<SymbolReference>, String>> {
        let point = tree_sitter::Point::new(position.line as usize, position.character as usize);
        let plan = self.with_project_modules(|modules, dirs| {
            rename_field(modules, dirs, uri.as_str(), point, new_name)
        })?;
        Some(plan.map(field_symbol_references))
    }

    /// The places that name the field at `position` for the same record, as
    /// a rename of it changes them, found by type inference over the project.
    /// `None` where no field stands there, and an error that says why where
    /// the server cannot tell them.
    pub fn field_references_at(
        &self,
        uri: &Url,
        position: Position,
    ) -> Option<Result<Vec<SymbolReference>, String>> {
        let point = tree_sitter::Point::new(position.line as usize, position.character as usize);
        let found = self.with_project_modules(|modules, dirs| {
            field_references(modules, dirs, uri.as_str(), point)
        })?;
        Some(found.map(field_symbol_references))
    }
}

fn field_symbol_references(edits: Vec<FieldEdit>) -> Vec<SymbolReference> {
    edits
        .into_iter()
        .filter_map(|edit| {
            Some(SymbolReference {
                uri: Url::parse(&edit.uri).ok()?,
                range: edit.range,
                is_definition: false,
                kind: Some(BoundSymbolKind::FieldType),
                type_context: None,
            })
        })
        .collect()
}

fn node_range(node: tree_sitter::Node) -> Range {
    let (start, end) = (node.start_position(), node.end_position());
    Range {
        start: Position::new(start.row as u32, start.column as u32),
        end: Position::new(end.row as u32, end.column as u32),
    }
}

/// The type variable of the type alias around the field at the identifier
/// `node` that no part of the alias uses but this field, if there is one
fn type_variable_left_unused(node: tree_sitter::Node, source: &str) -> Option<String> {
    let mut field = node;
    while field.kind() != "field_type" {
        field = field.parent()?;
    }
    let mut alias = field;
    while alias.kind() != "type_alias_declaration" {
        alias = alias.parent()?;
    }
    let mut used: Vec<&str> = Vec::new();
    let mut stack = vec![alias.child_by_field_name("typeExpression")?];
    while let Some(next) = stack.pop() {
        if next.id() == field.id() {
            continue;
        }
        // The base of an extensible record, `a` in `{ a | name : String }`, uses its variable too
        if matches!(next.kind(), "type_variable" | "record_base_identifier") {
            used.push(&source[next.byte_range()]);
        }
        let mut cursor = next.walk();
        stack.extend(next.children(&mut cursor));
    }
    let mut cursor = alias.walk();
    let params: Vec<&str> = alias
        .children_by_field_name("typeVariable", &mut cursor)
        .map(|param| &source[param.byte_range()])
        .collect();
    params
        .into_iter()
        .find(|param| !used.contains(param))
        .map(str::to_string)
}

fn contains(outer: &Range, inner: &Range) -> bool {
    let key = |p: &Position| (p.line, p.character);
    key(&outer.start) <= key(&inner.start) && key(&inner.end) <= key(&outer.end)
}

/// What removing the field does at the identifier `node`: the kind of use,
/// the stretch to replace and the text that takes its place. An access and
/// an accessor give way to `Debug.todo`, and in a record type, expression or
/// pattern the field goes with the separator next to it.
fn removal_at(
    node: tree_sitter::Node,
    source: &str,
    field_name: &str,
) -> Option<(FieldUsageType, Range, String)> {
    let parent = node.parent()?;
    match parent.kind() {
        "field_access_expr" => Some((
            FieldUsageType::FieldAccess,
            node_range(parent),
            format!("(Debug.todo \"FIXME: Field Removal: {}\")", field_name),
        )),
        "field_accessor_function_expr" => Some((
            FieldUsageType::FieldAccessor,
            node_range(parent),
            format!(
                "(\\_ -> Debug.todo \"FIXME: Field Removal: {}\")",
                field_name
            ),
        )),
        "field_type" => removal_from_list(parent, FieldUsageType::Definition, source),
        "field" => {
            let is_update = parent
                .parent()
                .and_then(|record| record.child_by_field_name("baseRecord"))
                .is_some();
            let usage_type = if is_update {
                FieldUsageType::RecordUpdate
            } else {
                FieldUsageType::RecordLiteral
            };
            removal_from_list(parent, usage_type, source)
        }
        "lower_pattern" => removal_from_list(parent, FieldUsageType::RecordPattern, source),
        _ => None,
    }
}

/// The removal of `item` from the record type, expression or pattern that
/// lists it. With the next item it takes the separator after it, the last
/// one takes the separator before it, so that one per line and all on one
/// line both stay well formed. The only item takes the record with it: an
/// extensible record type and a record update leave their base, a pattern
/// leaves `_`, and a record type or expression leaves `{}`.
fn removal_from_list(
    item: tree_sitter::Node,
    usage_type: FieldUsageType,
    source: &str,
) -> Option<(FieldUsageType, Range, String)> {
    let container = item.parent()?;
    let mut cursor = container.walk();
    let items: Vec<tree_sitter::Node> = container
        .named_children(&mut cursor)
        .filter(|child| child.kind() == item.kind())
        .collect();
    let index = items.iter().position(|other| other.id() == item.id())?;
    let span = |from: tree_sitter::Point, to: tree_sitter::Point| Range {
        start: Position::new(from.row as u32, from.column as u32),
        end: Position::new(to.row as u32, to.column as u32),
    };
    if let Some(next) = items.get(index + 1) {
        return Some((
            usage_type,
            span(item.start_position(), next.start_position()),
            String::new(),
        ));
    }
    if index > 0 {
        return Some((
            usage_type,
            span(items[index - 1].end_position(), item.end_position()),
            String::new(),
        ));
    }
    let replacement = match container.child_by_field_name("baseRecord") {
        Some(base) => source[base.byte_range()].to_string(),
        None if usage_type == FieldUsageType::RecordPattern => "_".to_string(),
        None => "{}".to_string(),
    };
    Some((usage_type, node_range(container), replacement))
}
