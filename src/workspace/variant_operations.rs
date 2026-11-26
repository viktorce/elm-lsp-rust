//! Variant operations for the Elm workspace.
//!
//! Contains functions for removing variants from custom types and
//! finding variant usages across the workspace.

use std::collections::HashMap;
use tower_lsp::lsp_types::*;

use super::file_operations::child_of_kind;
use super::resolve::{ModuleUsesOfEach, Namespace, Target};
use super::{ExposingInfo, ImportInfo, RemoveVariantResult, UsageType, VariantUsage, Workspace};

impl Workspace {
    /// Remove a variant from a custom type. Where the tool cannot make the
    /// removal right, it changes no file and says why.
    pub fn remove_variant(
        &self,
        uri: &Url,
        type_name: &str,
        variant_name: &str,
        _variant_index: usize,
        total_variants: usize,
    ) -> anyhow::Result<RemoveVariantResult> {
        if total_variants <= 1 {
            return Ok(RemoveVariantResult::error(
                "Cannot remove the only variant from a type",
            ));
        }
        let removal = match self.plan_variant_removal(uri, type_name, variant_name)? {
            Ok(removal) => removal,
            Err(reason) => {
                return Ok(RemoveVariantResult::error(&format!(
                    "No file was changed. {}",
                    reason
                )))
            }
        };

        let mut parts = vec![format!("Removed variant '{}'", variant_name)];
        if !removal.replaced.is_empty() {
            parts.push(format!(
                "replaced {} constructor usage(s) with Debug.todo",
                removal.replaced.len()
            ));
        }
        if !removal.removed.is_empty() {
            parts.push(format!(
                "removed {} pattern match branch(es)",
                removal.removed.len()
            ));
        }
        if !removal.redundant.is_empty() {
            parts.push(format!(
                "removed {} branch(es) that would match nothing: {}",
                removal.redundant.len(),
                removal
                    .redundant
                    .iter()
                    .map(|branch| format!("{}:{}", branch.module_name, branch.line + 1))
                    .collect::<Vec<_>>()
                    .join(", ")
            ));
        }
        let mut changes = removal.changes;
        Self::sort_edits_reverse(&mut changes);
        Ok(RemoveVariantResult::success(&parts.join(", "), changes))
    }

    /// The edits that remove a variant, and the places they change. The
    /// variant leaves its type's declaration with the bar or the equals
    /// sign in front of it and every line of its arguments. A branch whose
    /// pattern names it can no longer match and goes, with what its body
    /// holds. Every other use becomes Debug.todo, an application together
    /// with its arguments. A branch that would then match nothing that the
    /// branches above it do not, which Elm reports as redundant, goes too.
    /// The places come from the syntax tree and the resolver, so a comment,
    /// a string, a namesake and a layout over several lines mislead neither.
    /// `Err` holds the reason, with the place, where the tool cannot make the
    /// removal right.
    pub fn plan_variant_removal(
        &self,
        uri: &Url,
        type_name: &str,
        variant_name: &str,
    ) -> anyhow::Result<Result<VariantRemoval, String>> {
        let source_module = self.get_module_name_from_uri(uri);
        let Some((content, tree)) = self.read_and_parse(uri) else {
            return Ok(Err(format!("{} cannot be read", uri.path())));
        };
        let variants = match type_declaration(&tree, &content, type_name) {
            Some(declaration) => variant_names(declaration, &content),
            None => Vec::new(),
        };
        let Some(removed) = variants.iter().position(|v| v == variant_name) else {
            return Ok(Err(format!(
                "{} declares no type {} with a variant {}",
                source_module, type_name, variant_name
            )));
        };
        if variants.len() < 2 {
            return Ok(Err("Cannot remove the only variant from a type".to_string()));
        }
        let targets: Vec<Target> = variants
            .iter()
            .map(|name| Target {
                module: &source_module,
                name,
                namespace: Namespace::Constructor,
            })
            .collect();
        let remaining: Vec<String> = variants
            .iter()
            .filter(|name| *name != variant_name)
            .cloned()
            .collect();
        let variant = TypeVariant {
            type_name,
            variants: &variants,
            removed,
            remaining: &remaining,
        };

        let mut removal = VariantRemoval::default();
        for module in self.uses_of_each(&targets)? {
            let home = module.module_name == source_module;
            let edits = match self.removal_in_module(&module, &variant, home, &mut removal) {
                Ok(edits) => edits,
                Err(reason) => return Ok(Err(reason)),
            };
            if !edits.is_empty() {
                removal.changes.insert(module.uri.clone(), edits);
            }
        }
        if !removal.changes.contains_key(uri) {
            return Ok(Err(format!(
                "the declaration of {} in {} was not found",
                type_name, source_module
            )));
        }
        Ok(Ok(removal))
    }

    /// The edits of the removal in one module, which names a variant of the
    /// type. The places it changes go to `removal`.
    fn removal_in_module(
        &self,
        module: &ModuleUsesOfEach,
        variant: &TypeVariant,
        home: bool,
        removal: &mut VariantRemoval,
    ) -> Result<Vec<TextEdit>, String> {
        let content = module.source.as_str();
        let root = module.tree.root_node();
        let place = |node: tree_sitter::Node| {
            let path = module.uri.to_file_path().unwrap_or_default();
            let shown = path.strip_prefix(&self.root_path).unwrap_or(&path);
            format!("{}:{}", shown.display(), node.start_position().row + 1)
        };
        let removed_name = &variant.variants[variant.removed];

        // The constructors in patterns that are the type's variants, by where
        // their names begin, and the uses of the removed one
        let mut in_patterns: HashMap<usize, String> = HashMap::new();
        let mut pattern_uses = Vec::new();
        let mut value_uses = Vec::new();
        for (index, range, is_declaration) in &module.places {
            if *is_declaration {
                continue;
            }
            let start = to_point(range.start);
            let Some(name) = root.descendant_for_point_range(start, to_point(range.end)) else {
                continue;
            };
            let Some(qid) = name.parent().filter(|qid| qid.kind() == "upper_case_qid") else {
                continue;
            };
            let Some(holder) = qid.parent() else {
                continue;
            };
            match holder.kind() {
                "union_pattern" | "nullary_constructor_argument_pattern" => {
                    in_patterns.insert(qid.start_byte(), variant.variants[*index].clone());
                    if *index == variant.removed {
                        pattern_uses.push(qid);
                    }
                }
                "value_expr" if *index == variant.removed => value_uses.push(holder),
                "value_expr" => {}
                _ if *index == variant.removed => {
                    return Err(format!(
                        "at {} {} stands where this tool cannot tell what to put in its place",
                        place(qid),
                        removed_name
                    ))
                }
                _ => {}
            }
        }

        // Each pattern that names the variant has to be the pattern of a
        // branch. Elsewhere it would take the type apart, which Elm does not
        // allow for a type with another variant.
        let mut doomed: Vec<tree_sitter::Node> = Vec::new();
        for qid in &pattern_uses {
            let mut owner = qid.parent();
            while let Some(candidate) = owner {
                if matches!(
                    candidate.kind(),
                    "case_of_branch"
                        | "function_declaration_left"
                        | "anonymous_function_expr"
                        | "value_declaration"
                ) {
                    break;
                }
                owner = candidate.parent();
            }
            let branch = owner.filter(|owner| {
                owner.kind() == "case_of_branch"
                    && owner
                        .child_by_field_name("pattern")
                        .is_some_and(|pattern| contains_node(pattern, *qid))
            });
            match branch {
                Some(branch) => {
                    if !doomed.iter().any(|known| known.id() == branch.id()) {
                        doomed.push(branch);
                    }
                }
                None => {
                    return Err(format!(
                        "at {} a pattern outside a case names {}, and no branch can go for it",
                        place(*qid),
                        removed_name
                    ))
                }
            }
        }
        let inside_doomed = |node: tree_sitter::Node| {
            doomed
                .iter()
                .any(|branch| branch.id() != node.id() && contains_node(*branch, node))
        };

        let mut edits = Vec::new();
        if home {
            let declaration = type_declaration(&module.tree, content, variant.type_name)
                .ok_or_else(|| {
                    format!(
                        "{} declares no type {}",
                        module.module_name, variant.type_name
                    )
                })?;
            edits.push(variant_removal_edit(declaration, content, removed_name).ok_or_else(|| {
                format!(
                    "the declaration of {} at {} is laid out in a way this tool cannot take {} out of",
                    variant.type_name,
                    place(declaration),
                    removed_name
                )
            })?);
        }

        // The cases whose patterns name a variant of the type, which are the
        // ones where a branch can go. Those inside a branch that goes, go with it.
        let mut cases = Vec::new();
        Self::collect_case_expressions(&mut root.walk(), &mut cases);
        // The variants of a type of the project come from the resolver, and
        // those of a type of the core library that every module sees by name
        let variants_of = |constructor: tree_sitter::Node| {
            let name = constructor.child(constructor.child_count().checked_sub(1)?)?;
            if let Some(variants) = module.variants_of.get(&to_position(name.start_position())) {
                return Some(variants.clone());
            }
            let written = &content[constructor.byte_range()];
            let (qualifier, name) = written.rsplit_once('.').unwrap_or(("", written));
            CORE_VARIANTS
                .iter()
                .find(|(module, variants)| {
                    (qualifier.is_empty() || qualifier == *module) && variants.contains(&name)
                })
                .map(|(_, variants)| variants.iter().map(|v| v.to_string()).collect())
        };
        let mut gone: Vec<tree_sitter::Node> = Vec::new();
        for case in cases {
            if inside_doomed(case) || gone.iter().any(|branch| contains_node(*branch, case)) {
                continue;
            }
            let mut cursor = case.walk();
            let branches: Vec<tree_sitter::Node> =
                case.children_by_field_name("branch", &mut cursor).collect();
            let names_one = branches.iter().any(|branch| {
                branch
                    .child_by_field_name("pattern")
                    .is_some_and(|pattern| {
                        in_patterns
                            .keys()
                            .any(|at| pattern.start_byte() <= *at && *at < pattern.end_byte())
                    })
            });
            if !names_one {
                continue;
            }
            let mut kept: Vec<Vec<Pat>> = Vec::new();
            let mut going = Vec::new();
            for (index, branch) in branches.iter().enumerate() {
                if doomed.iter().any(|known| known.id() == branch.id()) {
                    going.push(index);
                    removal
                        .removed
                        .push(self.usage_of(module, *branch, UsageType::PatternMatch));
                    continue;
                }
                let Some(pattern) = branch.child_by_field_name("pattern") else {
                    return Err(format!("the branch at {} has no pattern", place(*branch)));
                };
                let row = vec![read_pattern(
                    pattern,
                    content,
                    &in_patterns,
                    variant.remaining,
                    &variants_of,
                )];
                let mut steps = MOST_STEPS;
                let surely = useful(&kept, &row, true, &mut steps);
                let maybe = useful(&kept, &row, false, &mut steps);
                if steps == 0 {
                    return Err(format!(
                        "the case at {} has too many branches to tell which of them still match a value once {} is gone",
                        place(case),
                        removed_name
                    ));
                }
                match (surely, maybe) {
                    (true, _) => kept.push(row),
                    (false, false) => {
                        going.push(index);
                        removal.redundant.push(self.usage_of(module, *branch, UsageType::PatternMatch));
                    }
                    (false, true) => {
                        return Err(format!(
                            "the branch at {} may match nothing once {} is gone, which Elm reports, and this tool cannot tell",
                            place(*branch),
                            removed_name
                        ))
                    }
                }
            }
            if going.is_empty() {
                continue;
            }
            if going.len() == branches.len() {
                return Err(format!(
                    "every branch of the case at {} matches {}, so nothing would be left of it",
                    place(case),
                    removed_name
                ));
            }
            for index in &going {
                gone.push(branches[*index]);
            }
            edits.extend(branch_removal_edits(&branches, &going, content).map_err(|branch| {
                format!(
                    "the branch at {} shares its line with other code, which this tool cannot take it out of",
                    place(branches[branch])
                )
            })?);
        }

        // Every other use of the variant becomes Debug.todo. An application
        // goes with its arguments, which can hold another use.
        let mut replaced: Vec<tree_sitter::Node> = Vec::new();
        for value in value_uses {
            if gone.iter().any(|branch| contains_node(*branch, value)) {
                continue;
            }
            let whole = value
                .parent()
                .filter(|call| {
                    call.kind() == "function_call_expr"
                        && call
                            .child_by_field_name("target")
                            .is_some_and(|target| target.id() == value.id())
                })
                .unwrap_or(value);
            replaced.push(whole);
        }
        let outermost: Vec<tree_sitter::Node> = replaced
            .iter()
            .filter(|node| {
                !replaced
                    .iter()
                    .any(|other| other.id() != node.id() && contains_node(*other, **node))
            })
            .copied()
            .collect();
        for node in outermost {
            let todo = format!("Debug.todo \"FIXME: Variant Removal: {}\"", removed_name);
            // Brackets around the use hold the call already
            let bracketed = node
                .parent()
                .is_some_and(|parent| parent.kind() == "parenthesized_expr");
            edits.push(TextEdit {
                range: node_range(node),
                new_text: if bracketed {
                    todo
                } else {
                    format!("({})", todo)
                },
            });
            removal
                .replaced
                .push(self.usage_of(module, node, UsageType::Constructor));
        }

        // Two edits that overlap would mangle the file. The places above are
        // apart by construction, and this keeps it so.
        edits.sort_by_key(|edit| (edit.range.start, edit.range.end));
        if let Some(pair) = edits
            .windows(2)
            .find(|pair| pair[1].range.start < pair[0].range.end)
        {
            return Err(format!(
                "two of its edits in {} overlap at line {}, which this tool does not make",
                module.module_name,
                pair[1].range.start.line + 1
            ));
        }
        Ok(edits)
    }

    /// A place that the removal changes, as the preview lists it
    fn usage_of(
        &self,
        module: &ModuleUsesOfEach,
        node: tree_sitter::Node,
        usage_type: UsageType,
    ) -> VariantUsage {
        let start = node.start_position();
        let position = Position {
            line: start.row as u32,
            character: start.column as u32,
        };
        let range = Some(node_range(node));
        let is_blocking = usage_type == UsageType::Constructor;
        VariantUsage {
            uri: module.uri.to_string(),
            line: position.line,
            character: position.character,
            is_blocking,
            context: module
                .source
                .lines()
                .nth(start.row)
                .map(|line| line.trim().to_string())
                .unwrap_or_default(),
            function_name: self
                .find_enclosing_function(&module.uri, position)
                .map(|(name, _)| name),
            module_name: module.module_name.clone(),
            call_chain: Vec::new(),
            usage_type,
            pattern_branch_range: if is_blocking { None } else { range },
            constructor_usage_range: if is_blocking { range } else { None },
        }
    }

    /// Find the enclosing function for a given position in a file
    fn find_enclosing_function(&self, uri: &Url, position: Position) -> Option<(String, String)> {
        // Find the module for this URI
        let path = uri.to_file_path().ok()?;

        for (module_name, module) in &self.modules {
            if module.path == path {
                // Find the function that contains this position
                for symbol in &module.symbols {
                    if symbol.kind == SymbolKind::FUNCTION {
                        // Check if position is within this function's range
                        if position.line >= symbol.range.start.line
                            && position.line <= symbol.range.end.line
                        {
                            return Some((symbol.name.clone(), module_name.clone()));
                        }
                    }
                }
                break;
            }
        }
        None
    }

    /// Recursively collect all case_of_expr nodes in the tree
    fn collect_case_expressions<'a>(
        cursor: &mut tree_sitter::TreeCursor<'a>,
        cases: &mut Vec<tree_sitter::Node<'a>>,
    ) {
        let node = cursor.node();
        if node.kind() == "case_of_expr" {
            cases.push(node);
        }

        if cursor.goto_first_child() {
            loop {
                Self::collect_case_expressions(cursor, cases);
                if !cursor.goto_next_sibling() {
                    break;
                }
            }
            cursor.goto_parent();
        }
    }

    // ========================================================================
    // Add Variant Operations
    // ========================================================================

    /// Prepare to add a new variant to a custom type
    /// Returns information about the type and case expressions that need new branches
    pub fn prepare_add_variant(
        &self,
        uri: &Url,
        type_name: &str,
        new_variant_name: &str,
    ) -> super::PrepareAddVariantResult {
        // Validate variant name starts with uppercase
        if !new_variant_name
            .chars()
            .next()
            .map(|c| c.is_uppercase())
            .unwrap_or(false)
        {
            return super::PrepareAddVariantResult::error(
                "Variant name must start with an uppercase letter",
            );
        }

        // Find the type in this module
        let path = match uri.to_file_path() {
            Ok(p) => p,
            Err(_) => return super::PrepareAddVariantResult::error("Invalid URI"),
        };

        let module = match self.find_module_by_path(&path) {
            Some(m) => m,
            None => return super::PrepareAddVariantResult::error("Module not found"),
        };

        // The type as the file holds it now, which the edits are made to
        let Some((content, tree)) = self.read_and_parse(uri) else {
            return super::PrepareAddVariantResult::error(&format!(
                "Cannot read {}",
                path.display()
            ));
        };
        let Some(declaration) = type_declaration(&tree, &content, type_name) else {
            return super::PrepareAddVariantResult::error(&format!(
                "Type '{}' not found in module",
                type_name
            ));
        };

        // Get existing variants
        let existing_variants = variant_names(declaration, &content);

        // Check if variant already exists
        if existing_variants.contains(&new_variant_name.to_string()) {
            return super::PrepareAddVariantResult::error(&format!(
                "Variant '{}' already exists in type '{}'",
                new_variant_name, type_name
            ));
        }

        // Another module can name the variants only where this one exposes them
        let exposes_variants = match self.extract_exposing(&tree, &content) {
            ExposingInfo::All => true,
            ExposingInfo::Explicit(exposed) => exposed.contains(&format!("{}(..)", type_name)),
        };
        let mut case_expressions = Vec::new();
        let mut unhandled = Vec::new();
        self.collect_cases_on_type(
            uri,
            &module.module_name,
            type_name,
            &existing_variants,
            exposes_variants,
            &mut case_expressions,
            &mut unhandled,
        );

        let cases_needing_branch = case_expressions.iter().filter(|c| !c.has_wildcard).count();

        let mut message = format!(
            "Found {} case expression(s) matching on '{}', {} need new branch",
            case_expressions.len(),
            type_name,
            cases_needing_branch
        );
        if !unhandled.is_empty() {
            message.push_str(&format!(
                ". {} place(s) need a branch for {} that this tool cannot write, so elm_add_variant changes nothing: {}",
                unhandled.len(),
                new_variant_name,
                unhandled.join("; ")
            ));
        }

        super::PrepareAddVariantResult {
            success: true,
            message,
            type_name: type_name.to_string(),
            variant_name: new_variant_name.to_string(),
            existing_variants,
            case_expressions,
            cases_needing_branch,
            unhandled,
        }
    }

    /// Collect the case expressions on the variants of a type, in the order of
    /// the files' paths and of the cases in each file, so that the index of a
    /// branch's code means the same case on every start of the server. A file
    /// can name the variants where it declares the type, or where it imports
    /// the module and the module exposes them. Each place where the compiler
    /// would ask for a branch that this tool cannot write goes to `unhandled`.
    #[allow(clippy::too_many_arguments)]
    fn collect_cases_on_type(
        &self,
        source_uri: &Url,
        source_module: &str,
        type_name: &str,
        variants: &[String],
        exposes_variants: bool,
        cases: &mut Vec<super::CaseExpressionInfo>,
        unhandled: &mut Vec<String>,
    ) {
        let mut files: Vec<(&super::ElmModule, Url)> = self
            .iter_non_evergreen_modules()
            .filter(|(module, uri)| {
                uri == source_uri
                    || (exposes_variants
                        && module
                            .imports
                            .iter()
                            .any(|import| import.module_name == source_module))
            })
            .collect();
        files.sort_by(|(one, _), (other, _)| one.path.cmp(&other.path));

        for (module, uri) in files {
            let Some((content, tree)) = self.read_and_parse(&uri) else {
                unhandled.push(format!("{} cannot be read", module.path.display()));
                continue;
            };
            let names = if uri == *source_uri {
                VariantNames {
                    variants,
                    bare: true,
                    qualifiers: Vec::new(),
                    shadowed: Vec::new(),
                }
            } else {
                let imports: Vec<ImportInfo> = self
                    .extract_imports(&tree, &content)
                    .into_iter()
                    .filter(|import| import.module_name == source_module)
                    .collect();
                VariantNames {
                    variants,
                    bare: imports.iter().any(|import| match &import.exposing {
                        ExposingInfo::All => true,
                        ExposingInfo::Explicit(exposed) => {
                            exposed.contains(&format!("{}(..)", type_name))
                        }
                    }),
                    qualifiers: imports
                        .iter()
                        .map(|import| import.alias.clone().unwrap_or(source_module.to_string()))
                        .collect(),
                    // A variant of the file's own type takes the bare name
                    shadowed: own_variant_names(&tree, &content),
                }
            };
            let variants_of = |written: &str| self.variants_alongside(&tree, &content, written);
            cases_in_file(
                &tree,
                &content,
                &names,
                &variants_of,
                &uri,
                &module.module_name,
                cases,
                unhandled,
            );
        }
    }

    /// All the variants of the type of a variant that a file writes, as in
    /// [Just, Nothing] for "Maybe.Just": of a type of the core library, of
    /// one that the file declares, or of one in a module that it imports.
    /// None where no such type has it, or more than one does.
    fn variants_alongside(
        &self,
        tree: &tree_sitter::Tree,
        content: &str,
        written: &str,
    ) -> Option<Vec<String>> {
        const CORE: [&[&str]; 4] = [
            &["True", "False"],
            &["Just", "Nothing"],
            &["Ok", "Err"],
            &["LT", "EQ", "GT"],
        ];
        let name = written.rsplit('.').next()?;
        let mut found: Vec<Vec<String>> = CORE
            .iter()
            .filter(|variants| variants.contains(&name))
            .map(|variants| variants.iter().map(|v| v.to_string()).collect())
            .collect();
        let root = tree.root_node();
        let mut cursor = root.walk();
        found.extend(
            root.children(&mut cursor)
                .filter(|declaration| declaration.kind() == "type_declaration")
                .map(|declaration| variant_names(declaration, content)),
        );
        for import in self.extract_imports(tree, content) {
            if let Some(module) = self.modules.get(&import.module_name) {
                found.extend(
                    module
                        .symbols
                        .iter()
                        .filter(|symbol| symbol.kind == SymbolKind::ENUM)
                        .map(|symbol| symbol.variants.iter().map(|v| v.name.clone()).collect()),
                );
            }
        }
        found.retain(|variants| variants.iter().any(|v| v == name));
        found.sort();
        found.dedup();
        match found.as_slice() {
            [variants] => Some(variants.clone()),
            _ => None,
        }
    }

    /// Find the position where new imports should be inserted in a file:
    /// the line below the last import, or below the module declaration.
    /// Both come from the parse tree, so an import that spans several lines
    /// and a line in a comment that reads like one are no trouble.
    fn find_import_insertion_point(&self, uri: &Url) -> Option<Position> {
        let (_, tree) = self.read_and_parse(uri)?;
        let root = tree.root_node();
        let mut cursor = root.walk();
        let last_clause = root
            .children(&mut cursor)
            .filter(|child| matches!(child.kind(), "module_declaration" | "import_clause"))
            .last();
        Some(Position {
            line: last_clause.map_or(0, |clause| code_end(clause).row as u32 + 1),
            character: 0,
        })
    }

    /// The number of arguments in the text of a variant's arguments, as in
    /// 2 for "Int (List String)", or `None` where it does not read as them
    fn argument_count(&self, arguments: &str) -> Option<usize> {
        let source = format!("type T\n    = V {}\n", arguments);
        let tree = self.parser.parse(&source)?;
        if tree.root_node().has_error() {
            return None;
        }
        let declaration = type_declaration(&tree, &source, "T")?;
        let mut cursor = declaration.walk();
        let variants: Vec<tree_sitter::Node> = declaration
            .children(&mut cursor)
            .filter(|child| child.kind() == "union_variant")
            .collect();
        match variants.as_slice() {
            [variant] => Some(code_children(*variant).len() - 1),
            _ => None,
        }
    }

    /// A file's text and its parse tree
    fn read_and_parse(&self, uri: &Url) -> Option<(String, tree_sitter::Tree)> {
        let content = self.read_file_content(uri)?;
        let tree = self.parser.parse(&content)?;
        Some((content, tree))
    }

    /// Add a new variant to a custom type and update all case expressions
    /// If `branches` is provided, each element corresponds to the case expression at that index.
    /// Each branch has { imports: [...], code: "..." }. Empty code = Debug.todo.
    /// When branches is provided, must match exact count of cases needing branches.
    pub fn add_variant(
        &self,
        uri: &Url,
        type_name: &str,
        new_variant_name: &str,
        variant_args: Option<&str>,
        branches: Option<&[super::BranchConfig]>,
    ) -> anyhow::Result<super::AddVariantResult> {
        // First, prepare to validate and gather info
        let prep = self.prepare_add_variant(uri, type_name, new_variant_name);
        if !prep.success {
            return Ok(super::AddVariantResult::error(&prep.message));
        }
        // A wrong branch would break the build where the compiler reports
        // nothing but the missing case, so the tool writes all or nothing
        if !prep.unhandled.is_empty() {
            return Ok(super::AddVariantResult::error(&format!(
                "No file was changed. {} place(s) need a branch for {} that this tool cannot write: {}. Add the variant and these branches by hand.",
                prep.unhandled.len(),
                new_variant_name,
                prep.unhandled.join("; ")
            )));
        }

        // Each argument of the variant takes a wildcard in a pattern
        let variant_args = variant_args.map(str::trim).filter(|args| !args.is_empty());
        let arity = match variant_args {
            None => 0,
            Some(args) => match self.argument_count(args) {
                Some(count) => count,
                None => {
                    return Ok(super::AddVariantResult::error(&format!(
                        "variant_args '{}' do not read as the arguments of one variant, such as 'Int (List String)'",
                        args
                    )))
                }
            },
        };

        // Validate branches count - if provided, must match exactly
        if let Some(br) = branches {
            if br.len() != prep.cases_needing_branch {
                return Ok(super::AddVariantResult::error_with_info(
                    &format!(
                        "Wrong number of branches: got {} but exactly {} case expression(s) need branches. Use elm_prepare_add_variant to see which cases need code.",
                        br.len(),
                        prep.cases_needing_branch
                    ),
                    prep,
                ));
            }
        }

        let (content, tree) = self
            .read_and_parse(uri)
            .ok_or_else(|| anyhow::anyhow!("Cannot read the file of {}", type_name))?;
        let declaration = type_declaration(&tree, &content, type_name)
            .ok_or_else(|| anyhow::anyhow!("Could not find type definition"))?;

        // Build the changes
        let mut changes: HashMap<Url, Vec<TextEdit>> = HashMap::new();

        // 1. Add the new variant after the last existing variant
        let variant_text = match variant_args {
            Some(args) => format!("{} {}", new_variant_name, args),
            None => new_variant_name.to_string(),
        };
        let variant_edit = new_variant_edit(declaration, &content, &variant_text)
            .ok_or_else(|| anyhow::anyhow!("Could not find the variants of {}", type_name))?;
        changes.entry(uri.clone()).or_default().push(variant_edit);

        // 2. Add branches to case expressions that don't have wildcards
        // Also collect imports per file for later
        let mut branches_added = 0;
        let mut branch_index = 0;
        let mut imports_by_file: HashMap<Url, Vec<String>> = HashMap::new();

        for case_info in &prep.case_expressions {
            if case_info.has_wildcard {
                continue; // Wildcard already handles new variants
            }

            if let Some(insert_range) = case_info.insert_range {
                let case_uri =
                    Url::parse(&case_info.uri).map_err(|_| anyhow::anyhow!("Invalid case URI"))?;

                // Default Debug.todo with variant name
                let default_todo = format!("Debug.todo \"Handle {}\"", new_variant_name);

                // Get branch config for this index, or use default
                let branch_body = if let Some(br) = branches {
                    if let Some(config) = br.get(branch_index) {
                        // Collect imports for this file
                        let imports = config.imports();
                        if !imports.is_empty() {
                            imports_by_file
                                .entry(case_uri.clone())
                                .or_default()
                                .extend(imports.iter().cloned());
                        }
                        // Use code or fall back to Debug.todo
                        match config.code() {
                            Some(code) => code.to_string(),
                            None => default_todo.clone(),
                        }
                    } else {
                        default_todo.clone()
                    }
                } else {
                    default_todo.clone()
                };

                // Build the new branches, one for each place of the variant
                // in the case's patterns. They all take the case's code.
                let branch_text: String = case_info
                    .patterns
                    .iter()
                    .map(|pattern| {
                        format!(
                            "\n\n{}{} ->\n{}    {}",
                            case_info.indentation,
                            pattern.with(new_variant_name, arity),
                            case_info.indentation,
                            branch_body
                        )
                    })
                    .collect();

                changes.entry(case_uri).or_default().push(TextEdit {
                    range: insert_range,
                    new_text: branch_text,
                });

                branches_added += case_info.patterns.len();
                branch_index += 1;
            }
        }

        // 3. Add imports to files (merge and dedupe per file)
        let mut imports_added = 0;
        for (file_uri, import_list) in imports_by_file {
            // Dedupe imports
            let mut unique_imports: Vec<String> = import_list.clone();
            unique_imports.sort();
            unique_imports.dedup();

            if !unique_imports.is_empty() {
                if let Some(import_pos) = self.find_import_insertion_point(&file_uri) {
                    let import_text = unique_imports
                        .iter()
                        .map(|i| format!("import {}", i))
                        .collect::<Vec<_>>()
                        .join("\n");

                    changes.entry(file_uri).or_default().push(TextEdit {
                        range: Range {
                            start: import_pos,
                            end: import_pos,
                        },
                        new_text: format!("{}\n", import_text),
                    });
                    imports_added += 1;
                }
            }
        }

        // Sort edits in reverse order
        Self::sort_edits_reverse(&mut changes);

        let has_custom_code = branches
            .map(|b| b.iter().any(|c| c.code().is_some()))
            .unwrap_or(false);
        let import_suffix = if imports_added > 0 {
            format!(", added imports to {} file(s)", imports_added)
        } else {
            String::new()
        };

        let message = if branches_added > 0 {
            if has_custom_code {
                format!(
                    "Added variant '{}' to '{}' and added {} case branch(es) with custom code{}",
                    new_variant_name, type_name, branches_added, import_suffix
                )
            } else {
                format!(
                    "Added variant '{}' to '{}' and added {} case branch(es) with Debug.todo{}",
                    new_variant_name, type_name, branches_added, import_suffix
                )
            }
        } else {
            format!(
                "Added variant '{}' to '{}' (all case expressions have wildcards){}",
                new_variant_name, type_name, import_suffix
            )
        };

        Ok(super::AddVariantResult::success(&message, changes))
    }
}

/// How the code of one file names the variants of a type
struct VariantNames<'a> {
    variants: &'a [String],
    /// Whether the name of a variant alone means it, as where the file
    /// declares the type or imports it with its variants
    bare: bool,
    /// The names that the file qualifies the variants with, the alias of the
    /// type's module or the module's name
    qualifiers: Vec<String>,
    /// The variants of the file's own types, which a bare name means there
    shadowed: Vec<String>,
}

impl VariantNames<'_> {
    /// Whether a constructor as the code writes it, as in "Route.Home", is
    /// one of the variants
    fn mean_one(&self, written: &str) -> bool {
        let is_variant = |name: &str| self.variants.iter().any(|variant| variant == name);
        match written.rsplit_once('.') {
            Some((qualifier, name)) => {
                self.qualifiers.iter().any(|q| q == qualifier) && is_variant(name)
            }
            None => self.bare && is_variant(written) && !self.shadowed.iter().any(|s| s == written),
        }
    }
}

/// One step from a pattern into a part of it
#[derive(Debug, Clone, PartialEq)]
enum Step {
    /// The item at `index` of a tuple of `arity` items
    Item { arity: usize, index: usize },
    /// The argument at `index` of a variant, written `name`, that takes `arity` of them
    Argument {
        name: String,
        arity: usize,
        index: usize,
    },
}

/// How the pattern of a branch meets the values that have the new variant
/// at the end of a path
#[derive(Debug, PartialEq)]
enum Meets {
    /// It takes none of them
    None,
    /// It takes some of them, because another part of it asks for more
    Some,
    /// It takes all of them
    All,
}

/// The case expressions in one file that branch on the variants. Each gets
/// the patterns of the branches that the new variant needs. A case where
/// this tool cannot tell those, and a pattern outside a case that takes
/// the type apart, go to `unhandled`.
fn cases_in_file(
    tree: &tree_sitter::Tree,
    content: &str,
    names: &VariantNames,
    variants_of: &dyn Fn(&str) -> Option<Vec<String>>,
    uri: &Url,
    module_name: &str,
    cases: &mut Vec<super::CaseExpressionInfo>,
    unhandled: &mut Vec<String>,
) {
    let place = |node: tree_sitter::Node| {
        let line = content
            .lines()
            .nth(node.start_position().row)
            .unwrap_or("")
            .trim();
        format!(
            "{}:{} `{}`",
            module_name,
            node.start_position().row + 1,
            line
        )
    };

    let mut case_nodes = Vec::new();
    Workspace::collect_case_expressions(&mut tree.root_node().walk(), &mut case_nodes);
    for case_node in case_nodes {
        let mut cursor = case_node.walk();
        let branches: Vec<tree_sitter::Node> = case_node
            .children(&mut cursor)
            .filter(|child| child.kind() == "case_of_branch")
            .collect();
        let patterns: Vec<tree_sitter::Node> = branches
            .iter()
            .filter_map(|branch| child_of_kind(*branch, "pattern"))
            .collect();

        let mut paths = Vec::new();
        let mut readable = true;
        for pattern in &patterns {
            readable &= variant_paths(*pattern, content, names, &mut Vec::new(), &mut paths);
        }
        if paths.is_empty() && readable {
            continue;
        }

        let catch_all = patterns.iter().any(|pattern| is_catch_all(*pattern));
        let mut new_patterns = Vec::new();
        if !catch_all {
            if !readable {
                unhandled.push(place(case_node));
                continue;
            }
            let mut tellable = true;
            for (path, qualifier) in &paths {
                let meetings: Vec<Meets> = patterns
                    .iter()
                    .map(|pattern| meets(*pattern, content, path))
                    .collect();
                if meetings.contains(&Meets::All) {
                    continue;
                }
                // The branches that take some of the values can take them
                // all together, as ( True, _ ) and ( False, _ ) do
                if meetings.contains(&Meets::Some) {
                    let partial: Vec<tree_sitter::Node> = patterns
                        .iter()
                        .zip(&meetings)
                        .filter(|(_, meeting)| **meeting == Meets::Some)
                        .map(|(pattern, _)| *pattern)
                        .collect();
                    match coverage(&partial, content, path, names.variants, variants_of) {
                        Coverage::All => continue,
                        Coverage::Missing => {}
                        Coverage::Unknown => {
                            tellable = false;
                            break;
                        }
                    }
                }
                new_patterns.push(branch_pattern(path, qualifier.clone()));
            }
            if !tellable {
                unhandled.push(place(case_node));
                continue;
            }
        }

        // The new branches go below the last one, lined up with it, and
        // below a comment at the end of its last line
        let last_branch = branches.last();
        let insert_range = last_branch.map(|branch| {
            let at = behind_the_line_comment(code_end(*branch), content);
            let position = Position {
                line: at.row as u32,
                character: at.column as u32,
            };
            Range {
                start: position,
                end: position,
            }
        });
        let indentation =
            " ".repeat(last_branch.map_or(8, |branch| branch.start_position().column));

        cases.push(super::CaseExpressionInfo {
            uri: uri.to_string(),
            line: case_node.start_position().row as u32,
            character: case_node.start_position().column as u32,
            context: content
                .lines()
                .nth(case_node.start_position().row)
                .map(|l| l.trim().to_string())
                .unwrap_or_default(),
            module_name: module_name.to_string(),
            has_wildcard: new_patterns.is_empty(),
            insert_range,
            indentation,
            patterns: new_patterns,
        });
    }

    // A pattern outside a case, of a function's argument, a lambda's or a
    // let, takes the type apart where the type has one variant. A second
    // one makes it incomplete, and no branch can complete it.
    let mut pending = vec![tree.root_node()];
    while let Some(node) = pending.pop() {
        let mut cursor = node.walk();
        pending.extend(node.children(&mut cursor));
        let is_constructor = node.kind() == "upper_case_qid"
            && node.parent().is_some_and(|parent| {
                matches!(
                    parent.kind(),
                    "union_pattern" | "nullary_constructor_argument_pattern"
                )
            });
        if !is_constructor || !names.mean_one(&content[node.byte_range()]) {
            continue;
        }
        let mut owner = node.parent();
        while let Some(candidate) = owner {
            if matches!(
                candidate.kind(),
                "case_of_branch"
                    | "function_declaration_left"
                    | "anonymous_function_expr"
                    | "value_declaration"
            ) {
                break;
            }
            owner = candidate.parent();
        }
        if !owner.is_some_and(|owner| owner.kind() == "case_of_branch") {
            unhandled.push(place(node));
        }
    }
}

/// Collect the path to each place in a pattern where one of the variants
/// stands, with the qualifier it is written with, each path once. Returns
/// false where one stands in a part that this tool writes no pattern for,
/// as in a list.
fn variant_paths(
    pattern: tree_sitter::Node,
    content: &str,
    names: &VariantNames,
    path: &mut Vec<Step>,
    found: &mut Vec<(Vec<Step>, Option<String>)>,
) -> bool {
    let node = bare_pattern(pattern);
    let walk_into = |parts: &[tree_sitter::Node],
                     step: &dyn Fn(usize) -> Step,
                     path: &mut Vec<Step>,
                     found: &mut Vec<(Vec<Step>, Option<String>)>| {
        let mut readable = true;
        for (index, part) in parts.iter().enumerate() {
            path.push(step(index));
            readable &= variant_paths(*part, content, names, path, found);
            path.pop();
        }
        readable
    };
    match node.kind() {
        "union_pattern" | "nullary_constructor_argument_pattern" => {
            let parts = code_children(node);
            let Some((constructor, arguments)) = parts.split_first() else {
                return true;
            };
            let written = &content[constructor.byte_range()];
            if names.mean_one(written) && !found.iter().any(|(known, _)| known == path) {
                let qualifier = written.rsplit_once('.').map(|(q, _)| q.to_string());
                found.push((path.clone(), qualifier));
            }
            let arity = arguments.len();
            let step = |index| Step::Argument {
                name: written.to_string(),
                arity,
                index,
            };
            walk_into(arguments, &step, path, found)
        }
        "tuple_pattern" => {
            let items = tuple_items(node);
            let arity = items.len();
            walk_into(&items, &|index| Step::Item { arity, index }, path, found)
        }
        _ => !mentions_one(node, content, names),
    }
}

/// How a pattern meets the values with the new variant at the end of `path`
fn meets(pattern: tree_sitter::Node, content: &str, path: &[Step]) -> Meets {
    let node = bare_pattern(pattern);
    if is_catch_all(node) {
        return Meets::All;
    }
    // Where the new variant goes, a pattern that is no catch-all names
    // another variant or a constant
    let Some((step, rest)) = path.split_first() else {
        return Meets::None;
    };
    let (parts, index) = match step {
        Step::Item { arity, index } if node.kind() == "tuple_pattern" => {
            let items = tuple_items(node);
            if items.len() != *arity {
                return Meets::None;
            }
            (items, *index)
        }
        Step::Argument { name, arity, index } if node.kind() == "union_pattern" => {
            let parts = code_children(node);
            let Some((constructor, arguments)) = parts.split_first() else {
                return Meets::None;
            };
            // "Just" and "Maybe.Just" are one variant in one place of a pattern
            let unqualified = |written: &str| written.rsplit('.').next().unwrap_or("").to_string();
            if unqualified(&content[constructor.byte_range()]) != unqualified(name)
                || arguments.len() != *arity
            {
                return Meets::None;
            }
            (arguments.to_vec(), *index)
        }
        _ => return Meets::None,
    };
    let others_take_all = parts
        .iter()
        .enumerate()
        .all(|(at, part)| at == index || takes_everything(*part));
    match meets(parts[index], content, rest) {
        Meets::None => Meets::None,
        Meets::All if others_take_all => Meets::All,
        _ => Meets::Some,
    }
}

/// The pattern of a new branch with the new variant at the end of `path`
/// and a wildcard for every other part
fn branch_pattern(path: &[Step], qualifier: Option<String>) -> super::BranchPattern {
    // Stands for the variant while the parts around it are written
    const HOLE: &str = "\u{0}";
    let mut text = HOLE.to_string();
    let mut is_application = false;
    for step in path.iter().rev() {
        let (arity, index) = match step {
            Step::Item { arity, index } | Step::Argument { arity, index, .. } => (*arity, *index),
        };
        let inner = if is_application {
            format!("({})", text)
        } else {
            text.clone()
        };
        let parts: Vec<String> = (0..arity)
            .map(|at| {
                if at == index {
                    inner.clone()
                } else {
                    "_".to_string()
                }
            })
            .collect();
        (text, is_application) = match step {
            Step::Item { .. } => (format!("( {} )", parts.join(", ")), false),
            Step::Argument { name, .. } => (format!("{} {}", name, parts.join(" ")), true),
        };
    }
    let (before, after) = text.split_once(HOLE).unwrap_or(("", ""));
    super::BranchPattern {
        before: before.to_string(),
        qualifier,
        after: after.to_string(),
        in_argument: matches!(path.last(), Some(Step::Argument { .. })),
    }
}

/// A pattern without the brackets around it and the "as" behind it
fn bare_pattern(mut node: tree_sitter::Node) -> tree_sitter::Node {
    while node.kind() == "pattern" {
        let mut cursor = node.walk();
        let parts: Vec<tree_sitter::Node> = node
            .children(&mut cursor)
            .take_while(|part| part.kind() != "as")
            .filter(|part| !is_comment(*part))
            .collect();
        node = match parts.as_slice() {
            [only] => *only,
            [open, inner, close] if open.kind() == "(" && close.kind() == ")" => *inner,
            _ => return node,
        };
    }
    node
}

/// Whether a pattern takes every value, as `_` and a name do
fn is_catch_all(pattern: tree_sitter::Node) -> bool {
    matches!(
        bare_pattern(pattern).kind(),
        "anything_pattern" | "lower_pattern"
    )
}

/// What branches that each take some of the values with the new variant at
/// the end of a path take together
#[derive(Debug, PartialEq)]
enum Coverage {
    /// All of them, so the case needs no branch there
    All,
    /// Not one value at least, so a branch there is needed and takes some
    Missing,
    /// The tool cannot tell
    Unknown,
}

/// The most combinations of the other places' variants that `coverage` tries
const MOST_COMBINATIONS: usize = 256;

/// What the patterns take together of the values with the new variant at
/// the end of `path`, from the variants of the types in the other places.
/// It tries each combination of those variants, and the new variant where
/// a place holds the type that gets it. A pattern takes one where
/// each of its places is a catch-all or that variant with catch-alls for
/// arguments, and misses it where one of its places is another variant.
fn coverage(
    patterns: &[tree_sitter::Node],
    content: &str,
    path: &[Step],
    extended: &[String],
    variants_of: &dyn Fn(&str) -> Option<Vec<String>>,
) -> Coverage {
    // The other places of each pattern, by depth and index, that are no catch-all
    let places: Vec<Vec<((usize, usize), tree_sitter::Node)>> = patterns
        .iter()
        .map(|pattern| other_places(*pattern, path))
        .collect();
    let mut keys: Vec<(usize, usize)> = places.iter().flatten().map(|(key, _)| *key).collect();
    keys.sort();
    keys.dedup();

    // Every variant of the type in each place, found through the variants written there
    let mut choices: Vec<Vec<String>> = Vec::new();
    for key in &keys {
        let written = places
            .iter()
            .flatten()
            .filter(|(at, _)| at == key)
            .find_map(|(_, part)| constructor_of(*part, content));
        let Some(mut variants) = written.and_then(|written| variants_of(&written)) else {
            return Coverage::Unknown;
        };
        // The type that gets the new variant has it in the other places too,
        // where no pattern names it yet
        if variants == extended {
            variants.push(String::new());
        }
        choices.push(variants);
    }
    let combinations = choices
        .iter()
        .try_fold(1usize, |count, variants| count.checked_mul(variants.len()));
    if !combinations.is_some_and(|count| count <= MOST_COMBINATIONS) {
        return Coverage::Unknown;
    }

    let unqualified = |written: &str| written.rsplit('.').next().unwrap_or("").to_string();
    let mut all_taken = true;
    for combination in 0..combinations.unwrap_or(0) {
        let mut rest = combination;
        let chosen: Vec<&String> = choices
            .iter()
            .map(|variants| {
                let variant = &variants[rest % variants.len()];
                rest /= variants.len();
                variant
            })
            .collect();
        let variant_at = |key: &(usize, usize)| chosen[keys.iter().position(|k| k == key).unwrap()];
        let mut taken = false;
        let mut missed_by_all = true;
        for pattern_places in &places {
            let mut takes = true;
            let mut misses = false;
            for (key, part) in pattern_places {
                let wanted = variant_at(key);
                match constructor_of(*part, content) {
                    Some(written) if unqualified(&written) != *wanted => misses = true,
                    Some(_)
                        if code_children(bare_pattern(*part))
                            .iter()
                            .skip(1)
                            .all(|argument| takes_everything(*argument)) => {}
                    _ => takes = false,
                }
            }
            taken |= takes && !misses;
            missed_by_all &= misses;
        }
        if missed_by_all {
            return Coverage::Missing;
        }
        all_taken &= taken;
    }
    if all_taken {
        Coverage::All
    } else {
        Coverage::Unknown
    }
}

/// The places of a pattern beside the path, each by its depth on the path
/// and its index there, that do not take everything
fn other_places<'t>(
    pattern: tree_sitter::Node<'t>,
    path: &[Step],
) -> Vec<((usize, usize), tree_sitter::Node<'t>)> {
    let mut places = Vec::new();
    let mut node = bare_pattern(pattern);
    for (depth, step) in path.iter().enumerate() {
        if is_catch_all(node) {
            break;
        }
        let (parts, index) = match step {
            Step::Item { index, .. } => (tuple_items(node), *index),
            Step::Argument { index, .. } => (code_children(node).split_off(1), *index),
        };
        for (at, part) in parts.iter().enumerate() {
            if at != index && !takes_everything(*part) {
                places.push(((depth, at), *part));
            }
        }
        let Some(next) = parts.get(index) else {
            break;
        };
        node = bare_pattern(*next);
    }
    places
}

/// The variant that a pattern names at its top, as the code writes it
fn constructor_of(pattern: tree_sitter::Node, content: &str) -> Option<String> {
    let node = bare_pattern(pattern);
    if !matches!(
        node.kind(),
        "union_pattern" | "nullary_constructor_argument_pattern"
    ) {
        return None;
    }
    let constructor = *code_children(node).first()?;
    Some(content[constructor.byte_range()].to_string())
}

/// Whether a pattern takes every value of its type. A variant can be the
/// only one of its type, which this tool does not know, so it counts as
/// taking fewer.
fn takes_everything(pattern: tree_sitter::Node) -> bool {
    let node = bare_pattern(pattern);
    match node.kind() {
        "anything_pattern" | "lower_pattern" | "record_pattern" | "unit_expr" => true,
        "tuple_pattern" => tuple_items(node).into_iter().all(takes_everything),
        _ => false,
    }
}

/// Whether a part of a pattern names one of the variants anywhere in it
fn mentions_one(node: tree_sitter::Node, content: &str, names: &VariantNames) -> bool {
    if node.kind() == "upper_case_qid" && names.mean_one(&content[node.byte_range()]) {
        return true;
    }
    let mut cursor = node.walk();
    let found = node
        .children(&mut cursor)
        .any(|child| mentions_one(child, content, names));
    found
}

/// The items of a tuple pattern
fn tuple_items(node: tree_sitter::Node) -> Vec<tree_sitter::Node> {
    let mut cursor = node.walk();
    let items = node
        .children(&mut cursor)
        .filter(|child| child.kind() == "pattern")
        .collect();
    items
}

/// The named children of a node that are no comments: of a variant's
/// pattern its constructor and its arguments, without their brackets
fn code_children(node: tree_sitter::Node) -> Vec<tree_sitter::Node> {
    let mut cursor = node.walk();
    let children = node
        .children(&mut cursor)
        .filter(|child| child.is_named() && !is_comment(*child))
        .collect();
    children
}

/// Whether a node is a comment, which the parser can put among the parts
/// of any node
fn is_comment(node: tree_sitter::Node) -> bool {
    node.is_extra() || matches!(node.kind(), "line_comment" | "block_comment")
}

/// Where the code of a node ends. The parser can hang the comments below a
/// node's last line on it, and a new line of code goes above those.
fn code_end(node: tree_sitter::Node) -> tree_sitter::Point {
    let mut cursor = node.walk();
    let children: Vec<tree_sitter::Node> = node.children(&mut cursor).collect();
    match children
        .iter()
        .rev()
        .find(|child| !is_comment(**child) && child.end_byte() > child.start_byte())
    {
        Some(child) => code_end(*child),
        None => node.end_position(),
    }
}

/// The end of the line of `at` where only a line comment or blanks follow
/// it there, and `at` itself otherwise. A new line goes below the comment,
/// which belongs to the line above it.
fn behind_the_line_comment(at: tree_sitter::Point, content: &str) -> tree_sitter::Point {
    let line = content.lines().nth(at.row).unwrap_or("");
    let rest = line.get(at.column..).unwrap_or("").trim_start();
    if rest.is_empty() || rest.starts_with("--") {
        tree_sitter::Point {
            row: at.row,
            column: line.len(),
        }
    } else {
        at
    }
}

/// The declaration of a custom type of this name at the top of a file
fn type_declaration<'t>(
    tree: &'t tree_sitter::Tree,
    content: &str,
    type_name: &str,
) -> Option<tree_sitter::Node<'t>> {
    let root = tree.root_node();
    let mut cursor = root.walk();
    let found = root.children(&mut cursor).find(|declaration| {
        declaration.kind() == "type_declaration"
            && child_of_kind(*declaration, "upper_case_identifier")
                .is_some_and(|name| &content[name.byte_range()] == type_name)
    });
    found
}

/// The names of a custom type's variants
fn variant_names(declaration: tree_sitter::Node, content: &str) -> Vec<String> {
    let mut cursor = declaration.walk();
    let names = declaration
        .children(&mut cursor)
        .filter(|child| child.kind() == "union_variant")
        .filter_map(|variant| variant.child(0))
        .map(|name| content[name.byte_range()].to_string())
        .collect();
    names
}

/// The variants of every custom type that a file declares
fn own_variant_names(tree: &tree_sitter::Tree, content: &str) -> Vec<String> {
    let root = tree.root_node();
    let mut cursor = root.walk();
    let names = root
        .children(&mut cursor)
        .filter(|declaration| declaration.kind() == "type_declaration")
        .flat_map(|declaration| variant_names(declaration, content))
        .collect();
    names
}

/// The edit that puts a new variant behind the last one of a type. It takes
/// the column of the bar or the equals sign in front of the last variant,
/// and goes below a comment at the end of the last variant's line. A type
/// on one line gets it on that line.
fn new_variant_edit(
    declaration: tree_sitter::Node,
    content: &str,
    variant: &str,
) -> Option<TextEdit> {
    let mut cursor = declaration.walk();
    let parts: Vec<tree_sitter::Node> = declaration
        .children(&mut cursor)
        .filter(|part| !is_comment(*part))
        .collect();
    let last = parts
        .iter()
        .rposition(|part| part.kind() == "union_variant")?;
    let separator = parts[..last].last()?;
    let type_row = declaration.start_position().row;
    let end = code_end(parts[last]);
    let (at, text) = if end.row == type_row {
        (end, format!(" | {}", variant))
    } else {
        let column = if separator.start_position().row == type_row {
            4
        } else {
            separator.start_position().column
        };
        (
            behind_the_line_comment(end, content),
            format!("\n{}| {}", " ".repeat(column), variant),
        )
    };
    let position = Position {
        line: at.row as u32,
        character: at.column as u32,
    };
    Some(TextEdit {
        range: Range {
            start: position,
            end: position,
        },
        new_text: text,
    })
}

/// The edits that remove a variant and the places that they change, in
/// the order of the files' paths and of the places in each file
#[derive(Debug, Default)]
pub struct VariantRemoval {
    pub changes: HashMap<Url, Vec<TextEdit>>,
    /// The uses that become Debug.todo
    pub replaced: Vec<VariantUsage>,
    /// The branches whose patterns name the variant
    pub removed: Vec<VariantUsage>,
    /// The branches that would match nothing once the variant is gone
    pub redundant: Vec<VariantUsage>,
}

/// The variant that a removal takes out of its type
struct TypeVariant<'a> {
    type_name: &'a str,
    /// All the variants of the type, the removed one among them
    variants: &'a [String],
    /// The index of the removed one in `variants`
    removed: usize,
    /// The variants that the type keeps
    remaining: &'a [String],
}

fn to_point(position: Position) -> tree_sitter::Point {
    tree_sitter::Point::new(position.line as usize, position.character as usize)
}

fn to_position(point: tree_sitter::Point) -> Position {
    Position {
        line: point.row as u32,
        character: point.column as u32,
    }
}

fn node_range(node: tree_sitter::Node) -> Range {
    Range {
        start: to_position(node.start_position()),
        end: to_position(node.end_position()),
    }
}

/// Whether `inner` lies within `outer`, or is it
fn contains_node(outer: tree_sitter::Node, inner: tree_sitter::Node) -> bool {
    outer.start_byte() <= inner.start_byte() && inner.end_byte() <= outer.end_byte()
}

/// The edit that takes a variant out of the declaration of its type, with
/// every line of its arguments and one separator. The first variant goes
/// with the bar behind it, and the equals sign stays. Any other goes with
/// the bar in front of it, and where it begins a line of its own, with its
/// lines and a comment at the end of the last. None where the type has no
/// such variant or no other.
fn variant_removal_edit(
    declaration: tree_sitter::Node,
    content: &str,
    name: &str,
) -> Option<TextEdit> {
    let mut cursor = declaration.walk();
    let variants: Vec<tree_sitter::Node> = declaration
        .children_by_field_name("unionVariant", &mut cursor)
        .collect();
    let index = variants.iter().position(|variant| {
        variant
            .child_by_field_name("name")
            .is_some_and(|written| &content[written.byte_range()] == name)
    })?;
    let variant = variants[index];
    let (start, end) = if index == 0 {
        (variant.start_position(), variants.get(1)?.start_position())
    } else {
        let previous_end = code_end(variants[index - 1]);
        let end = code_end(variant);
        if variant.start_position().row > previous_end.row {
            (
                behind_the_line_comment(previous_end, content),
                behind_the_line_comment(end, content),
            )
        } else {
            (previous_end, end)
        }
    };
    Some(TextEdit {
        range: Range {
            start: to_position(start),
            end: to_position(end),
        },
        new_text: String::new(),
    })
}

/// The edits that take the branches at the indices `going`, in ascending
/// order, out of a case. A run of branches that another one follows goes
/// from the start of its first line to the next line of code behind it, so
/// the blank lines go with it and a comment above the next branch stays. A
/// run at the end goes from the end of the line of the branch above it.
/// `Err` holds the index of a branch that does not begin its line, which
/// Elm's layout allows and these edits cannot take out.
fn branch_removal_edits(
    branches: &[tree_sitter::Node],
    going: &[usize],
    content: &str,
) -> Result<Vec<TextEdit>, usize> {
    let lines: Vec<&str> = content.split('\n').collect();
    let begins_its_line = |node: tree_sitter::Node| {
        let start = node.start_position();
        lines
            .get(start.row)
            .and_then(|line| line.get(..start.column))
            .is_some_and(|before| before.trim().is_empty())
    };
    let mut edits = Vec::new();
    let mut at = 0;
    while at < going.len() {
        let first = going[at];
        let mut last = first;
        while going.get(at + 1) == Some(&(last + 1)) {
            at += 1;
            last += 1;
        }
        at += 1;
        if !begins_its_line(branches[first]) {
            return Err(first);
        }
        let (start, end) = match branches.get(last + 1) {
            Some(next) => {
                if !begins_its_line(*next) {
                    return Err(last + 1);
                }
                let mut row = code_end(branches[last]).row + 1;
                while row < next.start_position().row
                    && lines.get(row).is_some_and(|line| line.trim().is_empty())
                {
                    row += 1;
                }
                (
                    tree_sitter::Point::new(branches[first].start_position().row, 0),
                    tree_sitter::Point::new(row, 0),
                )
            }
            // Not every branch goes, so one stands above the run
            None => (
                behind_the_line_comment(code_end(branches[first - 1]), content),
                behind_the_line_comment(code_end(branches[last]), content),
            ),
        };
        edits.push(TextEdit {
            range: Range {
                start: to_position(start),
                end: to_position(end),
            },
            new_text: String::new(),
        });
    }
    Ok(edits)
}

/// A pattern as the check for branches that match nothing reads it
#[derive(Debug, Clone)]
enum Pat {
    /// Takes every value: `_`, a name or a record
    Any,
    /// A variant, a tuple, a unit, `[]`, `::` or a literal, with its arguments
    Con {
        name: String,
        sig: Sig,
        args: Vec<Pat>,
    },
}

/// The constructors that the values of a pattern's type are made with
#[derive(Debug, Clone)]
enum Sig {
    /// These and no others
    Finite(Vec<String>),
    /// More than a case can name, as the numbers and the strings
    Infinite,
    /// The tool cannot find them
    Unknown,
}

/// The variants of the custom types of the core library that every module
/// can name, each with the module that declares it
const CORE_VARIANTS: [(&str, &[&str]); 4] = [
    ("Basics", &["True", "False"]),
    ("Maybe", &["Just", "Nothing"]),
    ("Result", &["Ok", "Err"]),
    ("Basics", &["LT", "EQ", "GT"]),
];

/// The most steps that one check of a branch takes, so that a case with
/// very many branches over tuples of large types cannot hang the server
const MOST_STEPS: usize = 100_000;

/// A pattern of a branch for the check. `in_patterns` has the variants of
/// the type that loses one, by where their names begin, and their type
/// keeps `remaining`. `variants_of` gives the variants of the type of any
/// other variant, by the node of its name as the pattern writes it.
fn read_pattern(
    node: tree_sitter::Node,
    content: &str,
    in_patterns: &HashMap<usize, String>,
    remaining: &[String],
    variants_of: &dyn Fn(tree_sitter::Node) -> Option<Vec<String>>,
) -> Pat {
    let read =
        |part: tree_sitter::Node| read_pattern(part, content, in_patterns, remaining, variants_of);
    let list = || Sig::Finite(vec!["[]".to_string(), "::".to_string()]);
    let node = bare_pattern(node);
    let single = |name: String, args: Vec<Pat>| Pat::Con {
        sig: Sig::Finite(vec![name.clone()]),
        name,
        args,
    };
    match node.kind() {
        "anything_pattern" | "lower_pattern" | "record_pattern" => Pat::Any,
        "unit_expr" => single("()".to_string(), Vec::new()),
        "tuple_pattern" => {
            let items = tuple_items(node);
            single(
                format!("({})", items.len()),
                items.into_iter().map(read).collect(),
            )
        }
        "union_pattern" | "nullary_constructor_argument_pattern" => {
            let parts = code_children(node);
            let Some((constructor, arguments)) = parts.split_first() else {
                return Pat::Any;
            };
            let args = arguments.iter().map(|argument| read(*argument)).collect();
            match in_patterns.get(&constructor.start_byte()) {
                Some(name) => Pat::Con {
                    name: name.clone(),
                    sig: Sig::Finite(remaining.to_vec()),
                    args,
                },
                None => {
                    let written = &content[constructor.byte_range()];
                    Pat::Con {
                        name: written.rsplit('.').next().unwrap_or(written).to_string(),
                        sig: variants_of(*constructor).map_or(Sig::Unknown, Sig::Finite),
                        args,
                    }
                }
            }
        }
        "list_pattern" | "cons_pattern" => {
            let parts = code_children(node);
            let (items, tail) = if node.kind() == "list_pattern" {
                let nil = Pat::Con {
                    name: "[]".to_string(),
                    sig: list(),
                    args: Vec::new(),
                };
                (&parts[..], nil)
            } else {
                match parts.split_last() {
                    Some((tail, items)) => (items, read(*tail)),
                    None => return Pat::Any,
                }
            };
            items.iter().rev().fold(tail, |tail, item| Pat::Con {
                name: "::".to_string(),
                sig: list(),
                args: vec![read(*item), tail],
            })
        }
        "char_constant_expr" | "string_constant_expr" | "number_constant_expr" => Pat::Con {
            name: content[node.byte_range()].to_string(),
            sig: Sig::Infinite,
            args: Vec::new(),
        },
        _ => Pat::Con {
            name: content[node.byte_range()].to_string(),
            sig: Sig::Unknown,
            args: Vec::new(),
        },
    }
}

/// Whether a value matches `row` and none of `rows`, by Maranget's check of
/// usefulness. A type whose constructors the tool does not know counts as
/// having just the ones the patterns name where `unknown_complete` holds,
/// so that a row useful then is useful in any case, and as having more
/// otherwise, so that a row useless then is useless in any case. Each call
/// takes a step, and a check out of steps counts as useful.
fn useful(rows: &[Vec<Pat>], row: &[Pat], unknown_complete: bool, steps: &mut usize) -> bool {
    if *steps == 0 {
        return true;
    }
    *steps -= 1;
    let Some((head, rest)) = row.split_first() else {
        return rows.is_empty();
    };
    if rows.is_empty() {
        return true;
    }
    let then = |arguments: Vec<Pat>| -> Vec<Pat> {
        arguments.into_iter().chain(rest.iter().cloned()).collect()
    };
    match head {
        Pat::Con { name, args, .. } => {
            let specialized = specialize(rows, name, args.len());
            useful(&specialized, &then(args.clone()), unknown_complete, steps)
        }
        Pat::Any => {
            // The constructors that the first column names, each once
            let mut heads: Vec<(&str, usize, &Sig)> = Vec::new();
            for each in rows {
                if let Pat::Con { name, sig, args } = &each[0] {
                    if !heads.iter().any(|(known, ..)| known == name) {
                        heads.push((name, args.len(), sig));
                    }
                }
            }
            let complete = heads.first().is_some_and(|(_, _, sig)| match sig {
                Sig::Finite(all) => all
                    .iter()
                    .all(|constructor| heads.iter().any(|(known, ..)| known == constructor)),
                Sig::Infinite => false,
                Sig::Unknown => unknown_complete,
            });
            if complete {
                heads.iter().any(|(name, arity, _)| {
                    let specialized = specialize(rows, name, *arity);
                    useful(
                        &specialized,
                        &then(vec![Pat::Any; *arity]),
                        unknown_complete,
                        steps,
                    )
                })
            } else {
                let default: Vec<Vec<Pat>> = rows
                    .iter()
                    .filter(|each| matches!(each[0], Pat::Any))
                    .map(|each| each[1..].to_vec())
                    .collect();
                useful(&default, rest, unknown_complete, steps)
            }
        }
    }
}

/// The rows that take a value made with the constructor, with its
/// arguments in place of their first pattern
fn specialize(rows: &[Vec<Pat>], name: &str, arity: usize) -> Vec<Vec<Pat>> {
    rows.iter()
        .filter_map(|each| {
            let arguments = match &each[0] {
                Pat::Con {
                    name: other, args, ..
                } if other == name => args.clone(),
                Pat::Con { .. } => return None,
                Pat::Any => vec![Pat::Any; arity],
            };
            Some(
                arguments
                    .into_iter()
                    .chain(each[1..].iter().cloned())
                    .collect(),
            )
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::super::test_support::{edited, project, uri_of};
    use super::super::{BranchConfig, CodeVariant, UsageType};
    use tempfile::TempDir;
    use tower_lsp::lsp_types::Url;

    const GEO_SHAPE: &str = r#"module Geo.Shape exposing (Kind(..), Shape(..), area, circles)


type Shape
    = Circle Float
    | Square Float


type Kind
    = Flat
    | Round


area : Shape -> Float
area shape =
    case shape of
        Circle r ->
            r * r

        Square s ->
            s * s


circles : List Float -> List Shape
circles =
    let
        make =
            \r -> Circle r
    in
    List.map make
"#;

    const STAMP: &str = r#"module Stamp exposing (Stamp(..), ink)


type Stamp
    = Circle
    | Star


ink : Stamp -> String
ink stamp =
    case stamp of
        Circle ->
            "round"

        Star ->
            "pointy"
"#;

    // Kind(..) lets out Flat and Round and no Circle, the bare Circle is
    // Stamp's, and Shape is the alias of Stamp
    const MAIN: &str = r#"module Main exposing (main)

import Geo.Shape as S exposing (Kind(..))
import Html exposing (Html, text)
import Stamp as Shape exposing (Stamp(..))


{-| A Circle in a comment
-}
label : Stamp -> String
label stamp =
    case stamp of
        Circle ->
            "Circle"

        Shape.Star ->
            -- Circle
            "star"


main : Html msg
main =
    text (label Shape.Circle ++ String.fromFloat (S.area (S.Circle 1)) ++ kind Flat)


kind : Kind -> String
kind k =
    if k == Round then
        "round"

    else
        "flat"
"#;

    #[test]
    fn test_the_uses_of_a_variant_are_the_ones_that_name_it() {
        let (dir, mut workspace) = project(&[
            ("Geo/Shape.elm", GEO_SHAPE),
            ("Stamp.elm", STAMP),
            ("Main.elm", MAIN),
        ]);
        // A test module, which elm-test compiles beside the source directories
        let check = dir.path().join("tests").join("ShapeCheck.elm");
        std::fs::create_dir_all(check.parent().unwrap()).unwrap();
        std::fs::write(
            &check,
            "module ShapeCheck exposing (unit)\n\nimport Geo.Shape\n\n\nunit : Geo.Shape.Shape\nunit =\n    Geo.Shape.Circle 1\n",
        )
        .unwrap();
        workspace.take_disk_changes();
        workspace.index_all_files().unwrap();

        let places = |file: &str, type_name: &str| {
            let removal = workspace
                .plan_variant_removal(&uri_of(&dir, file), type_name, "Circle")
                .unwrap()
                .unwrap();
            let shown = |usage: &super::super::VariantUsage| {
                let path = Url::parse(&usage.uri).unwrap().to_file_path().unwrap();
                let shown = path.strip_prefix(dir.path()).unwrap().display().to_string();
                (shown, usage.line, usage.character, usage.usage_type.clone())
            };
            let removed: Vec<_> = removal.removed.iter().map(shown).collect();
            let replaced: Vec<_> = removal.replaced.iter().map(shown).collect();
            (removed, replaced)
        };
        assert_eq!(
            places("Geo/Shape.elm", "Shape"),
            (
                vec![(
                    "src/Geo/Shape.elm".to_string(),
                    16,
                    8,
                    UsageType::PatternMatch
                )],
                vec![
                    (
                        "src/Geo/Shape.elm".to_string(),
                        27,
                        18,
                        UsageType::Constructor
                    ),
                    ("src/Main.elm".to_string(), 22, 58, UsageType::Constructor),
                    (
                        "tests/ShapeCheck.elm".to_string(),
                        7,
                        4,
                        UsageType::Constructor
                    ),
                ]
            )
        );

        // Stamp's variant is found in the modules where it is Stamp's
        let (removed, replaced) = places("Stamp.elm", "Stamp");
        let lines = |found: Vec<(String, u32, u32, UsageType)>| -> Vec<(String, u32)> {
            found
                .into_iter()
                .map(|(file, line, ..)| (file, line))
                .collect()
        };
        assert_eq!(
            lines(removed),
            vec![
                ("src/Main.elm".to_string(), 12),
                ("src/Stamp.elm".to_string(), 11),
            ]
        );
        assert_eq!(lines(replaced), vec![("src/Main.elm".to_string(), 22)]);
    }

    /// Add the variant, with arguments where given, and the text of each file
    /// afterwards, or the message where the tool changed nothing
    fn add(
        files: &[(&str, &str)],
        file: &str,
        type_name: &str,
        variant: &str,
        arguments: Option<&str>,
    ) -> Result<Vec<String>, String> {
        let (dir, workspace) = project(files);
        let result = workspace
            .add_variant(&uri_of(&dir, file), type_name, variant, arguments, None)
            .unwrap();
        texts(&dir, files, result)
    }

    fn texts(
        dir: &TempDir,
        files: &[(&str, &str)],
        result: super::super::AddVariantResult,
    ) -> Result<Vec<String>, String> {
        if !result.success {
            assert!(result.changes.is_none());
            return Err(result.message);
        }
        let changes = result.changes.unwrap();
        Ok(files
            .iter()
            .map(|(path, _)| edited(dir, &changes, path))
            .collect())
    }

    const DESCRIBE: &str = r#"

describe : Command -> String
describe command =
    case command of
        FetchAll ->
            "all"

        FetchOne id ->
            String.fromInt id

        Save text ->
            "save " ++ text
"#;

    const DESCRIBE_DELETE: &str = r#"

        Delete ->
            Debug.todo "Handle Delete""#;

    fn command_module(declaration: &str) -> String {
        format!(
            "module Command exposing (..)\n\n\n{}{}",
            declaration, DESCRIBE
        )
    }

    #[test]
    fn test_a_new_variant_goes_behind_the_last_one_past_comments() {
        let cases = [
            // A comment behind the equals sign, as elm-format writes a heading
            (
                "type Command\n    = -- Reading\n      FetchAll\n    | FetchOne Int\n    | Save String\n",
                "type Command\n    = -- Reading\n      FetchAll\n    | FetchOne Int\n    | Save String\n    | Delete\n",
            ),
            // A comment line between two variants
            (
                "type Command\n    = FetchAll\n    | FetchOne Int\n      -- Writing\n    | Save String\n",
                "type Command\n    = FetchAll\n    | FetchOne Int\n      -- Writing\n    | Save String\n    | Delete\n",
            ),
            // A comment behind the last variant stays on its line
            (
                "type Command\n    = FetchAll\n    | FetchOne Int\n    | Save String -- the last\n",
                "type Command\n    = FetchAll\n    | FetchOne Int\n    | Save String -- the last\n    | Delete\n",
            ),
            // and so does a comment below the type, which belongs to what follows
            (
                "type Command\n    = FetchAll\n    | FetchOne Int\n    | Save\n        String\n\n\n\n-- DESCRIBE\n",
                "type Command\n    = FetchAll\n    | FetchOne Int\n    | Save\n        String\n    | Delete\n\n\n\n-- DESCRIBE\n",
            ),
            // A type on one line
            (
                "type Command = FetchAll | FetchOne Int | Save String\n",
                "type Command = FetchAll | FetchOne Int | Save String | Delete\n",
            ),
        ];
        for (declaration, expected) in cases {
            let source = command_module(declaration);
            let texts = add(
                &[("Command.elm", &source)],
                "Command.elm",
                "Command",
                "Delete",
                None,
            )
            .unwrap();
            assert_eq!(
                texts[0],
                format!(
                    "{}{}\n",
                    command_module(expected).trim_end(),
                    DESCRIBE_DELETE
                ),
                "{}",
                declaration
            );
        }
    }

    const ROUTE: &str = "module Route exposing (Route(..), title)\n\n\ntype Route\n    = Start\n    | Settings\n    | Profile String\n\n\ntitle : Route -> String\ntitle route =\n    case route of\n        Start ->\n            \"start\"\n\n        Settings ->\n            \"settings\"\n\n        Profile name ->\n            name\n";

    const ROUTE_HELP: &str = "\n\n        Help ->\n            Debug.todo \"Handle Help\"\n";

    fn route_with_help() -> String {
        ROUTE
            .replace(
                "    | Profile String\n",
                "    | Profile String\n    | Help\n",
            )
            .trim_end()
            .to_string()
            + ROUTE_HELP
    }

    #[test]
    fn test_a_case_on_a_namesake_variant_of_another_type_gets_no_branch() {
        let panel = "module Panel exposing (Panel(..), width)\n\n\ntype Panel\n    = Start Int\n    | Hidden\n\n\nwidth : Panel -> Int\nwidth panel =\n    case panel of\n        Start size ->\n            size\n\n        Hidden ->\n            0\n";
        // Page takes Panel's variants along and qualifies Route's
        let page = "module Page exposing (size, name)\n\nimport Panel exposing (Panel(..))\nimport Route\n\n\nsize : Panel -> Int\nsize panel =\n    case panel of\n        Start n ->\n            n\n\n        Hidden ->\n            0\n\n\nname : Route.Route -> String\nname =\n    Route.title\n";
        // Here Start is the file's own variant, though Route's come along too
        let shadow = "module Shadow exposing (count)\n\nimport Route exposing (Route(..))\n\n\ntype Step\n    = Start\n    | Stop\n\n\ncount : Step -> Int\ncount step =\n    case step of\n        Start ->\n            1\n\n        Stop ->\n            0\n";
        let files = [
            ("Route.elm", ROUTE),
            ("Panel.elm", panel),
            ("Page.elm", page),
            ("Shadow.elm", shadow),
        ];
        let texts = add(&files, "Route.elm", "Route", "Help", None).unwrap();
        assert_eq!(
            texts,
            vec![
                route_with_help(),
                panel.to_string(),
                page.to_string(),
                shadow.to_string()
            ]
        );
    }

    #[test]
    fn test_a_new_branch_is_qualified_as_the_other_branches_of_its_case() {
        let qualified = "module Main exposing (main)\n\nimport Route\n\n\nmain : Route.Route -> String\nmain route =\n    case route of\n        Route.Start ->\n            \"start\"\n\n        Route.Settings ->\n            \"settings\"\n\n        Route.Profile name ->\n            name\n";
        let aliased = "module Other exposing (other)\n\nimport Route as R exposing (Route(..))\n\n\nother : R.Route -> Int\nother route =\n    let\n        count =\n            \\r ->\n                case r of\n                    R.Start ->\n                        1\n\n                    Settings ->\n                        2\n\n                    R.Profile _ ->\n                        3\n    in\n    count route\n";
        let files = [
            ("Route.elm", ROUTE),
            ("Main.elm", qualified),
            ("Other.elm", aliased),
        ];
        let texts = add(&files, "Route.elm", "Route", "Help", None).unwrap();
        assert_eq!(texts[0], route_with_help());
        assert_eq!(
            texts[1],
            format!(
                "{}\n\n        Route.Help ->\n            Debug.todo \"Handle Help\"\n",
                qualified.trim_end()
            )
        );
        // The first branch on the type decides, here R.Start
        assert_eq!(
            texts[2],
            aliased.replace(
                "                        3\n",
                "                        3\n\n                    R.Help ->\n                        Debug.todo \"Handle Help\"\n"
            )
        );
    }

    const LANG: &str =
        "module Lang exposing (Lang(..))\n\n\ntype Lang\n    = En\n    | Fr\n    | De\n";

    #[test]
    fn test_a_case_on_a_tuple_or_a_wrapper_gets_a_branch_around_the_new_variant() {
        let words = r#"module Words exposing (greet, maybe, any)

import Lang exposing (Lang(..))


greet : Lang -> Bool -> String
greet lang formal =
    case ( lang, formal ) of
        ( En, True ) ->
            "Good day"

        ( En, False ) ->
            "Hi"

        ( Fr, _ ) ->
            "Bonjour"

        ( De, _ ) ->
            "Hallo"


maybe : Maybe Lang -> String
maybe lang =
    case lang of
        Just En ->
            "en"

        Just Fr ->
            "fr"

        Just De ->
            "de"

        Nothing ->
            ""


any : Maybe Lang -> String
any lang =
    case lang of
        Just En ->
            "en"

        Just _ ->
            "other"

        Nothing ->
            ""
"#;
        let files = [("Lang.elm", LANG), ("Words.elm", words)];
        let texts = add(&files, "Lang.elm", "Lang", "It", Some("Int (List String)")).unwrap();
        assert_eq!(texts[0], format!("{}    | It Int (List String)\n", LANG));
        let todo = "Debug.todo \"Handle It\"";
        assert_eq!(
            texts[1],
            words
                .replace(
                    "            \"Hallo\"\n",
                    &format!("            \"Hallo\"\n\n        ( It _ _, _ ) ->\n            {}\n", todo)
                )
                .replace(
                    "        Nothing ->\n            \"\"\n\n\nany",
                    &format!("        Nothing ->\n            \"\"\n\n        Just (It _ _) ->\n            {}\n\n\nany", todo)
                )
        );
    }

    #[test]
    fn test_branches_that_take_part_of_the_values_get_a_branch_where_they_miss_one() {
        let words = r#"module Words exposing (both, flagged, paced, polite)

import Lang exposing (Lang(..))


type Speed
    = Slow
    | Fast


both : ( Lang, Lang ) -> Int
both pair =
    case pair of
        ( En, En ) ->
            0

        ( _, En ) ->
            1

        ( _, Fr ) ->
            1

        ( _, De ) ->
            1


flagged : Maybe Int -> Lang -> Int
flagged flag lang =
    case ( flag, lang ) of
        ( Just _, _ ) ->
            0

        ( Nothing, En ) ->
            1

        ( Nothing, Fr ) ->
            2

        ( Nothing, De ) ->
            3


paced : ( Speed, Lang ) -> Int
paced pair =
    case pair of
        ( Slow, _ ) ->
            0

        ( Fast, En ) ->
            1

        ( Fast, _ ) ->
            2


polite : ( Lang, Bool ) -> String
polite pair =
    case pair of
        ( En, _ ) ->
            "Hi"

        ( Fr, _ ) ->
            "Salut"

        ( _, True ) ->
            "Good day"

        ( De, False ) ->
            "Hallo"
"#;
        let files = [("Lang.elm", LANG), ("Words.elm", words)];
        let texts = add(&files, "Lang.elm", "Lang", "It", None).unwrap();
        let branch = |pattern: &str| {
            format!(
                "\n\n        {} ->\n            Debug.todo \"Handle It\"",
                pattern
            )
        };
        // ( _, En ) and its like miss ( It, It ), and nothing takes ( _, It ).
        // ( Just _, _ ) misses ( Nothing, It ), and ( _, True ) misses
        // ( It, False ). ( Slow, _ ) and ( Fast, _ ) take every Speed.
        assert_eq!(
            texts[1],
            words
                .replace(
                    "        ( _, De ) ->\n            1\n",
                    &format!(
                        "        ( _, De ) ->\n            1{}{}\n",
                        branch("( It, _ )"),
                        branch("( _, It )")
                    )
                )
                .replace(
                    "        ( Nothing, De ) ->\n            3\n",
                    &format!(
                        "        ( Nothing, De ) ->\n            3{}\n",
                        branch("( _, It )")
                    )
                )
                .replace(
                    "            \"Hallo\"\n",
                    &format!("            \"Hallo\"{}\n", branch("( It, _ )"))
                )
        );
    }

    #[test]
    fn test_a_case_whose_new_branch_the_tool_cannot_tell_changes_nothing() {
        // Whether ( _, 0 ) takes all of ( It, _ ) depends on every Int
        let partly = "module Words exposing (greet)\n\nimport Lang exposing (Lang(..))\n\n\ngreet : ( Lang, Int ) -> String\ngreet pair =\n    case pair of\n        ( En, _ ) ->\n            \"Hi\"\n\n        ( Fr, _ ) ->\n            \"Salut\"\n\n        ( _, 0 ) ->\n            \"None\"\n\n        ( De, _ ) ->\n            \"Hallo\"\n";
        let listed = "module Words exposing (first)\n\nimport Lang exposing (Lang(..))\n\n\nfirst : List Lang -> String\nfirst langs =\n    case langs of\n        [] ->\n            \"\"\n\n        En :: _ ->\n            \"en\"\n\n        Fr :: _ ->\n            \"fr\"\n\n        De :: _ ->\n            \"de\"\n";
        for (words, line) in [(partly, 8), (listed, 8)] {
            let message = add(
                &[("Lang.elm", LANG), ("Words.elm", words)],
                "Lang.elm",
                "Lang",
                "It",
                None,
            )
            .unwrap_err();
            assert!(
                message.contains(&format!("Words:{} `case", line)),
                "{}",
                message
            );
        }

        // A type of one variant that a function's argument takes apart
        let only = "module Only exposing (Only(..), value)\n\n\ntype Only\n    = Only Int\n\n\nvalue : Only -> Int\nvalue (Only n) =\n    n\n";
        let message = add(&[("Only.elm", only)], "Only.elm", "Only", "Other", None).unwrap_err();
        assert!(message.contains("Only:9 `value (Only n) =`"), "{}", message);
    }

    #[test]
    fn test_a_case_in_the_last_branch_of_another_gets_its_branch_first() {
        let route = r#"module Route exposing (Route(..), pair)


type Route
    = Start
    | Settings


pair : Route -> Route -> Int
pair one other =
    case one of
        Start ->
            0

        Settings ->
            case other of
                Start ->
                    1

                Settings ->
                    2
"#;
        let texts = add(&[("Route.elm", route)], "Route.elm", "Route", "Help", None).unwrap();
        assert_eq!(
            texts[0],
            route.replace("    | Settings\n", "    | Settings\n    | Help\n").trim_end().to_string()
                + "\n\n                Help ->\n                    Debug.todo \"Handle Help\"\n\n        Help ->\n            Debug.todo \"Handle Help\"\n"
        );
    }

    #[test]
    fn test_the_code_of_a_branch_goes_to_the_case_of_its_index_in_the_order_of_paths() {
        let user = |name: &str| {
            format!("module {} exposing (f)\n\nimport Lang exposing (Lang(..))\n\n\nf : Lang -> Int\nf lang =\n    case lang of\n        En ->\n            1\n\n        Fr ->\n            2\n\n        De ->\n            3\n", name)
        };
        let (first, second, third) = (user("A.First"), user("B"), user("C"));
        // Listed in another order than their paths
        let files = [
            ("C.elm", third.as_str()),
            ("Lang.elm", LANG),
            ("A/First.elm", first.as_str()),
            ("B.elm", second.as_str()),
        ];
        let (dir, workspace) = project(&files);
        let codes: Vec<BranchConfig> = ["10", "20", "30"]
            .iter()
            .map(|code| BranchConfig::Code(CodeVariant::AddCode(code.to_string())))
            .collect();
        let result = workspace
            .add_variant(&uri_of(&dir, "Lang.elm"), "Lang", "It", None, Some(&codes))
            .unwrap();
        let texts = texts(&dir, &files, result).unwrap();
        for (text, code) in [(&texts[2], "10"), (&texts[3], "20"), (&texts[0], "30")] {
            assert!(
                text.ends_with(&format!("        It ->\n            {}\n", code)),
                "{}",
                text
            );
        }
    }

    #[test]
    fn test_a_new_branch_takes_a_wildcard_for_each_argument_of_the_variant() {
        let texts = add(
            &[("Route.elm", ROUTE)],
            "Route.elm",
            "Route",
            "Help",
            Some(" Int (List String) "),
        )
        .unwrap();
        assert_eq!(
            texts[0],
            route_with_help()
                .replace("    | Help\n", "    | Help Int (List String)\n")
                .replace("        Help ->", "        Help _ _ ->")
        );

        // Blank arguments are none
        let texts = add(
            &[("Route.elm", ROUTE)],
            "Route.elm",
            "Route",
            "Help",
            Some(" "),
        )
        .unwrap();
        assert_eq!(texts[0], route_with_help());
    }

    #[test]
    fn test_imports_of_a_branch_go_below_the_last_import() {
        let user = "module User exposing (f)\n\n{-\nimport Lost\n-}\nimport Lang\n    exposing\n        ( Lang(..)\n        )\n\n\nf : Lang -> Int\nf lang =\n    case lang of\n        En ->\n            1\n\n        Fr ->\n            2\n\n        De ->\n            3\n";
        let files = [("Lang.elm", LANG), ("User.elm", user)];
        let (dir, workspace) = project(&files);
        let codes = [BranchConfig::CodeWithImports(
            super::super::CodeWithImportsVariant::AddCodeWithImports {
                imports: vec!["Dict".to_string()],
                code: "Dict.size Dict.empty".to_string(),
            },
        )];
        let result = workspace
            .add_variant(&uri_of(&dir, "Lang.elm"), "Lang", "It", None, Some(&codes))
            .unwrap();
        let texts = texts(&dir, &files, result).unwrap();
        assert_eq!(
            texts[1],
            user.replace("        )\n\n", "        )\nimport Dict\n\n")
                + "\n        It ->\n            Dict.size Dict.empty\n"
        );
    }

    #[test]
    fn test_arguments_that_do_not_read_as_a_variant_s_change_nothing() {
        let message = add(
            &[("Lang.elm", LANG)],
            "Lang.elm",
            "Lang",
            "It",
            Some("Int |"),
        )
        .unwrap_err();
        assert!(message.contains("'Int |'"), "{}", message);
    }

    /// Remove the variant, and the text of each file afterwards with the
    /// tool's message, or the message where the tool changed nothing
    fn remove(
        files: &[(&str, &str)],
        file: &str,
        type_name: &str,
        variant: &str,
    ) -> Result<(Vec<String>, String), String> {
        let (dir, workspace) = project(files);
        let result = workspace
            .remove_variant(&uri_of(&dir, file), type_name, variant, 0, 2)
            .unwrap();
        if !result.success {
            assert!(result.changes.is_none());
            return Err(result.message);
        }
        let changes = result.changes.unwrap();
        let texts = files
            .iter()
            .map(|(path, _)| edited(&dir, &changes, path))
            .collect();
        Ok((texts, result.message))
    }

    const SHAPE: &str = r#"module Shape exposing (Shape(..), area)


type Shape
    = Dot
    | Square
        { side : Float
        }
    | Circle Float


area : Shape -> Float
area shape =
    case shape of
        Dot ->
            0

        Square { side } ->
            side * side

        Circle radius ->
            3 * radius * radius
"#;

    #[test]
    fn test_a_variant_goes_with_the_lines_of_its_arguments() {
        let (texts, _) = remove(&[("Shape.elm", SHAPE)], "Shape.elm", "Shape", "Square").unwrap();
        assert_eq!(
            texts[0],
            SHAPE
                .replace("    | Square\n        { side : Float\n        }\n", "")
                .replace(
                    "        Square { side } ->\n            side * side\n\n",
                    ""
                )
        );

        // The first variant leaves the equals sign to the next one
        let first = "module Shape exposing (Shape(..))\n\n\ntype Shape\n    = Square\n        { side : Float\n        }\n    | Dot\n";
        let (texts, _) = remove(&[("Shape.elm", first)], "Shape.elm", "Shape", "Square").unwrap();
        assert_eq!(
            texts[0],
            "module Shape exposing (Shape(..))\n\n\ntype Shape\n    = Dot\n"
        );

        // A comment at the end of a variant's line goes with it, and the one above stays
        let commented = "module Shape exposing (Shape(..))\n\n\ntype Shape\n    = Dot\n    | Square Float -- four sides\n    | Circle Float -- round\n";
        let (texts, _) =
            remove(&[("Shape.elm", commented)], "Shape.elm", "Shape", "Circle").unwrap();
        assert_eq!(texts[0], "module Shape exposing (Shape(..))\n\n\ntype Shape\n    = Dot\n    | Square Float -- four sides\n");

        // A type on one line keeps its line
        let line = "module Size exposing (Size(..))\n\n\ntype Size = Small | Medium | Large\n";
        let removed = |variant: &str| {
            remove(&[("Size.elm", line)], "Size.elm", "Size", variant)
                .unwrap()
                .0[0]
                .clone()
        };
        assert_eq!(removed("Small"), line.replace("Small | ", ""));
        assert_eq!(removed("Medium"), line.replace(" | Medium", ""));
        assert_eq!(removed("Large"), line.replace(" | Large", ""));
    }

    const LIGHT: &str = r#"module Light exposing (Light(..), describe)


type Light
    = Walk
    | Wait
    | Halt


describe : Light -> Light -> String
describe first second =
    case first of
        Walk ->
            case second of
                Walk ->
                    "both walk"

                _ ->
                    "one walks"

        Wait ->
            "wait"

        Halt ->
            "halt"
"#;

    const LIGHT_WITHOUT_WALK: &str = r#"module Light exposing (Light(..), describe)


type Light
    = Wait
    | Halt


describe : Light -> Light -> String
describe first second =
    case first of
        Wait ->
            "wait"

        Halt ->
            "halt"
"#;

    #[test]
    fn test_a_branch_inside_a_removed_branch_goes_with_it() {
        let (texts, message) =
            remove(&[("Light.elm", LIGHT)], "Light.elm", "Light", "Walk").unwrap();
        assert_eq!(texts[0], LIGHT_WITHOUT_WALK);
        assert!(
            message.contains("removed 1 pattern match branch(es)"),
            "{}",
            message
        );

        // In another module, qualified, with a case in a let and a lambda in
        // the removed branch, and a use in a case inside a branch that stays
        let main = r#"module Main exposing (main, pace)

import Light


pace : Light.Light -> Light.Light -> Int
pace first second =
    case first of
        Light.Walk ->
            let
                again =
                    \light ->
                        case light of
                            Light.Walk ->
                                Light.Walk

                            _ ->
                                light
            in
            List.length [ again second ]

        _ ->
            case second of
                Light.Halt ->
                    0

                _ ->
                    pace Light.Walk second


main : Int
main =
    pace Light.Wait Light.Halt
"#;
        let (texts, message) = remove(
            &[
                (
                    "Light.elm",
                    LIGHT_WITHOUT_WALK
                        .replace("= Wait", "= Walk\n    | Wait")
                        .as_str(),
                ),
                ("Main.elm", main),
            ],
            "Light.elm",
            "Light",
            "Walk",
        )
        .unwrap();
        assert_eq!(texts[0], LIGHT_WITHOUT_WALK);
        let start = main.find("        Light.Walk ->").unwrap();
        let end = main.find("        _ ->\n            case second").unwrap();
        let expected = format!("{}{}", &main[..start], &main[end..]).replace(
            "pace Light.Walk second",
            "pace (Debug.todo \"FIXME: Variant Removal: Walk\") second",
        );
        assert_eq!(texts[1], expected);
        assert!(
            message.contains("replaced 1 constructor usage(s)"),
            "{}",
            message
        );
        assert!(
            message.contains("removed 1 pattern match branch(es)"),
            "{}",
            message
        );
    }

    #[test]
    fn test_an_application_inside_a_replaced_one_goes_with_it() {
        let tree = "module Tree exposing (Tree(..), deep)\n\n\ntype Tree\n    = Leaf\n    | Node Tree\n\n\ndeep : Tree\ndeep =\n    Node (Node Leaf)\n\n\nwide : List Tree\nwide =\n    [ (Node Leaf), Leaf ]\n";
        let (texts, message) = remove(&[("Tree.elm", tree)], "Tree.elm", "Tree", "Node").unwrap();
        assert_eq!(
            texts[0],
            "module Tree exposing (Tree(..), deep)\n\n\ntype Tree\n    = Leaf\n\n\ndeep : Tree\ndeep =\n    (Debug.todo \"FIXME: Variant Removal: Node\")\n\n\nwide : List Tree\nwide =\n    [ (Debug.todo \"FIXME: Variant Removal: Node\"), Leaf ]\n"
        );
        assert!(
            message.contains("replaced 2 constructor usage(s)"),
            "{}",
            message
        );
    }

    #[test]
    fn test_a_line_that_begins_like_a_variant_of_the_type_is_a_use() {
        // The lines `|> Go` and `= Go n` stand above the type, and read like
        // the lines of its variants
        let signal = r#"module Signal exposing (Signal(..), start, twice)


start : Int -> Signal
start n =
    n
        |> Go


twice : Int -> Signal
twice n =
    let
        first
            = Go n
    in
    first


type Signal
    = Go Int
    | Stop
"#;
        let main = "module Main exposing (main)\n\nimport Signal exposing (Signal(..))\n\n\nmain : Int\nmain =\n    case Signal.start 3 of\n        Go n ->\n            n\n\n        Stop ->\n            0\n";
        let (texts, _) = remove(
            &[("Signal.elm", signal), ("Main.elm", main)],
            "Signal.elm",
            "Signal",
            "Go",
        )
        .unwrap();
        let todo = "(Debug.todo \"FIXME: Variant Removal: Go\")";
        assert_eq!(
            texts[0],
            signal
                .replace("        |> Go\n", &format!("        |> {}\n", todo))
                .replace("            = Go n\n", &format!("            = {}\n", todo))
                .replace("    = Go Int\n    | Stop\n", "    = Stop\n")
        );
        assert_eq!(
            texts[1],
            main.replace("        Go n ->\n            n\n\n", "")
        );
    }

    #[test]
    fn test_a_module_named_like_the_variant_is_no_use_of_it() {
        let route = "module Route exposing (Route(..))\n\n\ntype Route\n    = Home\n    | About\n";
        let page = "module Page.About exposing (view)\n\nimport Html exposing (Html, text)\n\n\nview : Html msg\nview =\n    text \"about\"\n";
        let main = r#"module Main exposing (main)

import Html exposing (Html, div, text)
import Html.Attributes as About
import Page.About
import Route exposing (Route(..))


page : Route -> Html msg
page route =
    case route of
        Home ->
            text "home"

        About ->
            text "about"


main : Html msg
main =
    div [ About.class "page" ] [ page Home, Page.About.view ]
"#;
        let (texts, _) = remove(
            &[
                ("Route.elm", route),
                ("Page/About.elm", page),
                ("Main.elm", main),
            ],
            "Route.elm",
            "Route",
            "About",
        )
        .unwrap();
        assert_eq!(texts[0], route.replace("\n    | About", ""));
        assert_eq!(texts[1], page);
        assert_eq!(
            texts[2],
            main.replace("\n\n        About ->\n            text \"about\"", "")
        );
    }

    #[test]
    fn test_uses_through_an_alias_an_exposing_list_and_a_port_module_are_replaced() {
        let light = "module Light exposing (Light(..))\n\n\ntype Light\n    = Walk\n    | Wait\n";
        let ports = r#"port module Ports exposing (send)

import Light as L exposing (Light(..))


port out : String -> Cmd msg


send : { config : { light : L.Light } } -> Cmd msg
send state =
    if state.config.light == L.Walk || state == { config = { light = Walk } } then
        out "walk"

    else
        out "wait"
"#;
        let main = "module Main exposing (lights)\n\nimport Light exposing (Light)\n\n\nlights : List Light\nlights =\n    [ Light.Walk, Light.Wait ]\n";
        let (texts, message) = remove(
            &[
                ("Light.elm", light),
                ("Ports.elm", ports),
                ("Main.elm", main),
            ],
            "Light.elm",
            "Light",
            "Walk",
        )
        .unwrap();
        let todo = "(Debug.todo \"FIXME: Variant Removal: Walk\")";
        assert_eq!(texts[0], light.replace("Walk\n    | ", ""));
        assert_eq!(
            texts[1],
            ports
                .replace("== L.Walk", &format!("== {}", todo))
                .replace("light = Walk", &format!("light = {}", todo))
        );
        assert_eq!(texts[2], main.replace("Light.Walk", todo));
        assert!(
            message.contains("replaced 3 constructor usage(s)"),
            "{}",
            message
        );
    }

    #[test]
    fn test_a_branch_that_would_match_nothing_goes_too() {
        let light = r#"module Light exposing (Light(..), name, order, pair, wrapped)


type Light
    = Walk
    | Wait
    | Halt


name : Light -> String
name light =
    case light of
        Wait ->
            "wait"

        Halt ->
            "halt"

        _ ->
            "walk"


order : Int -> Int -> String
order a b =
    case compare a b of
        LT ->
            "less"

        GT ->
            "more"

        _ ->
            "same"


pair : Light -> Int -> Bool -> String
pair light n flag =
    case ( light, n ) of
        ( Wait, _ ) ->
            "wait"

        ( Halt, _ ) ->
            "halt"

        ( _, 0 ) ->
            "zero"

        _ ->
            case ( light, flag ) of
                ( Wait, True ) ->
                    "yes"

                _ ->
                    "no"


wrapped : Maybe Light -> String
wrapped maybe =
    case maybe of
        Just Wait ->
            "wait"

        Just Halt ->
            "halt"

        Nothing ->
            "none"

        Just _ ->
            "walk"
"#;
        let (texts, message) =
            remove(&[("Light.elm", light)], "Light.elm", "Light", "Walk").unwrap();
        let mut expected = light.replace("    = Walk\n    | Wait\n", "    = Wait\n");
        for branch in [
            "\n\n        _ ->\n            \"walk\"",
            "        ( _, 0 ) ->\n            \"zero\"\n\n",
            "\n\n        Just _ ->\n            \"walk\"",
        ] {
            assert!(expected.contains(branch), "{}", branch);
            expected = expected.replacen(branch, "", 1);
        }
        // The catch-all of pair stays as the last branch, and loses its case
        let tail = "\n\n        _ ->\n            case ( light, flag ) of\n                ( Wait, True ) ->\n                    \"yes\"\n\n                _ ->\n                    \"no\"";
        expected = expected.replacen(tail, "", 1);
        assert_eq!(texts[0], expected);
        assert!(
            message.contains("removed 4 branch(es) that would match nothing"),
            "{}",
            message
        );
    }

    #[test]
    fn test_a_branch_that_may_match_nothing_changes_nothing() {
        // Whether `_` still matches a value depends on the variants of
        // Http.Error, which the tool does not know
        let light = r#"module Light exposing (Light(..), problem)

import Http


type Light
    = Walk
    | Wait
    | Halt


problem : Light -> Http.Error -> String
problem light error =
    case ( light, error ) of
        ( Wait, _ ) ->
            "wait"

        ( _, Http.Timeout ) ->
            "slow"

        ( Halt, Http.NetworkError ) ->
            "down"

        _ ->
            "other"
"#;
        let message = remove(&[("Light.elm", light)], "Light.elm", "Light", "Walk").unwrap_err();
        assert!(message.starts_with("No file was changed."), "{}", message);
        assert!(
            message.contains("the branch at src/Light.elm:24 may match nothing"),
            "{}",
            message
        );

        // A type of the project with variants of the same names is not
        // Http.Error, so it tells nothing either
        let net =
            "module Net exposing (Fault(..))\n\n\ntype Fault\n    = Timeout\n    | NetworkError\n";
        let importing = light.replace(
            "import Http\n",
            "import Http\nimport Net exposing (Fault(..))\n",
        );
        let message = remove(
            &[("Light.elm", &importing), ("Net.elm", net)],
            "Light.elm",
            "Light",
            "Walk",
        )
        .unwrap_err();
        assert!(
            message.contains("the branch at src/Light.elm:25 may match nothing"),
            "{}",
            message
        );

        // Through an alias of its module the project's type is told, and the
        // catch-all goes, since (Walk, N.NetworkError) was all that it took
        let told = importing
            .replace("import Net exposing (Fault(..))", "import Net as N")
            .replace("Http.Error", "N.Fault")
            .replace("Http.Timeout", "N.Timeout")
            .replace("Http.NetworkError", "N.NetworkError");
        let (texts, message) = remove(
            &[("Light.elm", &told), ("Net.elm", net)],
            "Light.elm",
            "Light",
            "Walk",
        )
        .unwrap();
        assert_eq!(
            texts[0],
            told.replace("    = Walk\n    | Wait\n", "    = Wait\n")
                .replace("\n\n        _ ->\n            \"other\"", "")
        );
        assert!(
            message.contains("removed 1 branch(es) that would match nothing"),
            "{}",
            message
        );
    }

    #[test]
    fn test_an_alias_of_a_custom_type_leaves_its_name_to_the_imported_variant() {
        // Only a record alias is a constructor, so `Ticket "x"` is the variant of Tickets
        let tickets = "module Tickets exposing (Ticket(..))\n\n\ntype Ticket\n    = Ticket String\n    | Closed\n";
        let main = "module Main exposing (Ticket, make)\n\nimport Tickets exposing (Ticket(..))\n\n\ntype alias Ticket =\n    Tickets.Ticket\n\n\nmake : Ticket\nmake =\n    Ticket \"x\"\n";
        let (texts, _) = remove(
            &[("Tickets.elm", tickets), ("Main.elm", main)],
            "Tickets.elm",
            "Ticket",
            "Ticket",
        )
        .unwrap();
        assert_eq!(texts[0], tickets.replace("Ticket String\n    | ", ""));
        assert_eq!(
            texts[1],
            main.replace(
                "Ticket \"x\"",
                "(Debug.todo \"FIXME: Variant Removal: Ticket\")"
            )
        );
    }
}
