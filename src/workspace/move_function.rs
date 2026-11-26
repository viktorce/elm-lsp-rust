//! The plan of moving a function to another module: the names that the move
//! writes anew, the imports it adds, and the reasons it would be wrong, such
//! as an import cycle. The MCP server moves the lines by the plan.

use std::collections::{BTreeMap, BTreeSet};
use std::path::Path;
use tower_lsp::lsp_types::*;

use super::resolve::{text, walk, Declared, ModuleView, Occurrence, Site};
use super::{ExposingInfo, ImportInfo, Namespace, Workspace};

/// The modules every Elm module imports without a line for it, each with the
/// qualifier it goes by.
const DEFAULT_IMPORTS: &[(&str, &str)] = &[
    ("Basics", "Basics"),
    ("Char", "Char"),
    ("Debug", "Debug"),
    ("List", "List"),
    ("Maybe", "Maybe"),
    ("Platform", "Platform"),
    ("Platform.Cmd", "Cmd"),
    ("Platform.Sub", "Sub"),
    ("Result", "Result"),
    ("String", "String"),
    ("Tuple", "Tuple"),
];

/// The names the default imports give every module bare: all of Basics, and
/// a type or two of the others.
const DEFAULT_VALUES: &[&str] = &[
    "toFloat",
    "round",
    "floor",
    "ceiling",
    "truncate",
    "max",
    "min",
    "compare",
    "not",
    "xor",
    "modBy",
    "remainderBy",
    "negate",
    "abs",
    "clamp",
    "sqrt",
    "logBase",
    "e",
    "pi",
    "cos",
    "sin",
    "tan",
    "acos",
    "asin",
    "atan",
    "atan2",
    "degrees",
    "radians",
    "turns",
    "toPolar",
    "fromPolar",
    "isNaN",
    "isInfinite",
    "identity",
    "always",
    "never",
];
const DEFAULT_TYPES: &[&str] = &[
    "Int", "Float", "Bool", "Order", "Never", "List", "Maybe", "Result", "String", "Char",
    "Program", "Cmd", "Sub",
];
const DEFAULT_CONSTRUCTORS: &[&str] = &[
    "True", "False", "LT", "EQ", "GT", "Just", "Nothing", "Ok", "Err",
];
const DEFAULT_OPERATORS: &[&str] = &[
    "+", "-", "*", "/", "//", "^", "==", "/=", "<", ">", "<=", ">=", "&&", "||", "++", "<|", "|>",
    "<<", ">>", "::",
];

/// Whether the default imports give every module the name bare
fn is_default_name(namespace: Namespace, name: &str) -> bool {
    match namespace {
        Namespace::Value => DEFAULT_VALUES.contains(&name),
        Namespace::Type => DEFAULT_TYPES.contains(&name),
        Namespace::Constructor => DEFAULT_CONSTRUCTORS.contains(&name),
    }
}

/// What a move of a function to another module changes beyond the lines of
/// the function, worked out the way the compiler reads each name. The MCP
/// server cuts and pastes the lines and edits the imports by it.
#[derive(Debug, Default, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MovePlan {
    /// Names written anew, by the path of their file: in the function, in the
    /// destination and in the modules that call the function. Columns count bytes.
    pub edits: BTreeMap<String, Vec<TextEdit>>,
    /// The modules the destination imports anew, under their whole names
    pub target_imports: Vec<String>,
    /// The function's old module calls it elsewhere, so it imports the
    /// function by name from the destination
    pub called_at_home: bool,
    /// Every other module that names the function, by its path
    pub users: Vec<MoveUser>,
}

/// A module other than the two of the move that names the function.
#[derive(Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MoveUser {
    pub path: String,
    /// It calls the function bare, or lists it in an import, so it imports
    /// the function by name from the destination
    pub bare: bool,
    /// It calls the function with a qualifier and has no import of the
    /// destination, which it then gets
    pub needs_import: bool,
}

/// How a module names the function that moves.
#[derive(Default)]
struct Uses {
    /// It calls the function bare, or lists it in an import
    bare: bool,
    /// Its calls with a qualifier, each with the qualifier
    qualified: Vec<Range>,
    /// A bare use of a namesake that the module declares or imports
    namesake: Option<Range>,
}

/// How a module can name another one with a qualifier.
enum Qualified {
    /// Through an import, under this qualifier
    As(String),
    /// Through an import that it gets, or through the default imports
    Anew(String),
}

impl Workspace {
    /// Where a name of the project stands, for a reason given to the agent
    fn place(&self, path: &Path, range: &Range) -> String {
        let shown = path.strip_prefix(&self.root_path).unwrap_or(path);
        format!("{}:{}", shown.display(), range.start.line + 1)
    }

    /// The plan of moving the top-level function `function_name` from the
    /// module of `source_path` to the module of `target_path`. `Err` within
    /// holds the reason the move cannot be made right, which names the place.
    /// Every name of the function keeps its meaning in the destination, and
    /// every call of it names the function in its new module afterwards.
    pub fn plan_move(
        &self,
        source_path: &Path,
        function_name: &str,
        target_path: &Path,
    ) -> anyhow::Result<Result<MovePlan, String>> {
        let views = self.module_views()?;
        let declared: BTreeMap<String, Declared> = views
            .iter()
            .map(|view| {
                (
                    view.module.module_name.clone(),
                    Declared::of(view.tree.root_node(), &view.source),
                )
            })
            .collect();
        let find = |path: &Path| views.iter().position(|view| view.module.path == path);
        let source_at = find(source_path).ok_or_else(|| {
            anyhow::anyhow!("{} is no module of the project", source_path.display())
        })?;
        let target_at = find(target_path).ok_or_else(|| {
            anyhow::anyhow!("{} is no module of the project", target_path.display())
        })?;
        let (source, target) = (&views[source_at], &views[target_at]);
        let source_name = source.module.module_name.as_str();
        let target_name = target.module.module_name.as_str();
        if source_at == target_at {
            return Ok(Err(format!(
                "{} is the module that has the function",
                target_name
            )));
        }
        let target_declared = &declared[target_name];
        if target_declared.has(Namespace::Value, function_name) {
            return Ok(Err(format!(
                "{} already declares a {}",
                target_name, function_name
            )));
        }

        // The type annotation and the definition of the function
        let root = source.tree.root_node();
        let mut cursor = root.walk();
        let parts: Vec<tree_sitter::Node> = root
            .children(&mut cursor)
            .filter(|node| declared_name(*node, &source.source) == Some(function_name))
            .collect();
        if parts.is_empty() {
            return Ok(Err(format!(
                "{} declares no function {}",
                source_name, function_name
            )));
        }
        let within = |range: &Range| {
            parts
                .iter()
                .any(|part| contains(&range_of_node(*part), range))
        };

        let mut plan = MovePlan::default();
        let mut new_edges: Vec<(String, String)> = Vec::new();
        let mut target_imports: BTreeSet<String> = BTreeSet::new();
        let path_of = |view: &ModuleView| view.module.path.to_string_lossy().into_owned();

        // The names of the function, as the destination has to write them
        let mut body_edits = Vec::new();
        let mut refusal: Option<String> = None;
        for part in &parts {
            let mut visit = |occurrence: Occurrence, bound: &[&str]| {
                if refusal.is_some() || occurrence.site != Site::Use {
                    return;
                }
                match self.written_in_target(
                    &declared,
                    source,
                    target,
                    function_name,
                    &occurrence,
                    bound,
                ) {
                    // The record of an update takes no qualifier
                    Ok((Some(written), _)) if is_record_base(source, &occurrence.range) => {
                        refusal = Some(format!(
                            "at {} the function updates the record {}, which the compiler takes only by a bare name, and {} has to write it {}",
                            self.place(&source.module.path, &occurrence.range),
                            occurrence.name,
                            target.module.module_name,
                            written
                        ))
                    }
                    Ok((written, import)) => {
                        if let Some(written) = written {
                            body_edits.push(TextEdit {
                                range: whole_name(&occurrence),
                                new_text: written,
                            });
                        }
                        target_imports.extend(import);
                    }
                    Err(reason) => {
                        refusal = Some(format!(
                            "at {} {}",
                            self.place(&source.module.path, &occurrence.range),
                            reason
                        ))
                    }
                }
            };
            walk(*part, &source.source, &mut Vec::new(), &mut visit);
        }
        if let Some(reason) = refusal {
            return Ok(Err(reason));
        }
        for part in &parts {
            if let Some(reason) = self.operator_unreachable(*part, source, target) {
                return Ok(Err(reason));
            }
        }

        // Elm lets no local name hide a top-level one of its module
        for part in &parts {
            let mut binders = Vec::new();
            local_binders(*part, &source.source, &mut binders);
            if let Some((name, range)) = binders
                .iter()
                .find(|(name, _)| target_declared.has(Namespace::Value, name))
            {
                return Ok(Err(format!(
                    "at {} the function binds {}, which {} declares, and the compiler does not let one hide the other",
                    self.place(&source.module.path, range),
                    name,
                    target_name
                )));
            }
        }
        let mut target_binders = Vec::new();
        local_binders(target.tree.root_node(), &target.source, &mut target_binders);
        if let Some((_, range)) = target_binders
            .iter()
            .find(|(name, _)| name == function_name)
        {
            return Ok(Err(format!(
                "at {} {} binds a local {}, which the moved function would be hidden by",
                self.place(&target.module.path, range),
                target_name,
                function_name
            )));
        }

        // The old module calls the function elsewhere. It cannot name itself with a qualifier.
        let home = self.uses_of_moved(&declared, source, source_name, function_name, &within);
        plan.called_at_home = home.bare;
        if home.bare && !imports(source, target_name) {
            new_edges.push((source_name.to_string(), target_name.to_string()));
        }

        // The destination calls it bare from then on
        let there = self.uses_of_moved(&declared, target, source_name, function_name, &|_| false);
        if let Some(range) = there.namesake {
            return Ok(Err(format!(
                "at {} {} names another {}, which the moved function would take the place of",
                self.place(&target.module.path, &range),
                target_name,
                function_name
            )));
        }
        if !there.qualified.is_empty() {
            plan.edits.insert(
                path_of(target),
                there
                    .qualified
                    .into_iter()
                    .map(|range| TextEdit {
                        range,
                        new_text: function_name.to_string(),
                    })
                    .collect(),
            );
        }

        // Every other module that names it names the destination instead
        for (at, view) in views.iter().enumerate() {
            if at == source_at || at == target_at {
                continue;
            }
            let uses = self.uses_of_moved(&declared, view, source_name, function_name, &|_| false);
            if !uses.bare && uses.qualified.is_empty() {
                continue;
            }
            let qualifier = match qualifier_in(&view.module.imports, target_name) {
                Some(qualifier) => qualifier,
                None => {
                    return Ok(Err(format!(
                        "{} names other modules by {} as well, so a call of {} through it could mean either",
                        view.module.module_name, target_name, function_name
                    )))
                }
            };
            let lacks_import = matches!(qualifier, Qualified::Anew(_));
            let qualifier = match qualifier {
                Qualified::As(qualifier) | Qualified::Anew(qualifier) => qualifier,
            };
            if !uses.qualified.is_empty() {
                plan.edits.insert(
                    path_of(view),
                    uses.qualified
                        .into_iter()
                        .map(|range| TextEdit {
                            range,
                            new_text: format!("{}.{}", qualifier, function_name),
                        })
                        .collect(),
                );
            }
            if lacks_import {
                new_edges.push((view.module.module_name.clone(), target_name.to_string()));
            }
            plan.users.push(MoveUser {
                path: path_of(view),
                bare: uses.bare,
                needs_import: lacks_import && !uses.bare,
            });
        }

        for module in &target_imports {
            new_edges.push((target_name.to_string(), module.clone()));
        }
        if let Some(cycle) = self.closed_cycle(&new_edges) {
            return Ok(Err(format!("it would close an import cycle: {}", cycle)));
        }

        if !body_edits.is_empty() {
            plan.edits.insert(path_of(source), body_edits);
        }
        plan.target_imports = target_imports.into_iter().collect();
        Ok(Ok(plan))
    }

    /// How a module names the function that moves out of `source_name`.
    /// `skip` passes over the places of the function itself.
    fn uses_of_moved(
        &self,
        declared: &BTreeMap<String, Declared>,
        view: &ModuleView,
        source_name: &str,
        function_name: &str,
        skip: &dyn Fn(&Range) -> bool,
    ) -> Uses {
        let mut uses = Uses::default();
        let mut visit = |occurrence: Occurrence, bound: &[&str]| {
            if occurrence.namespace != Namespace::Value
                || occurrence.name != function_name
                || skip(&occurrence.range)
            {
                return;
            }
            let resolved = self.resolve_occurrence(declared, view, &occurrence, bound);
            match occurrence.site {
                _ if resolved != Some(source_name) => {
                    if occurrence.site == Site::Use
                        && occurrence.qualifier.is_none()
                        && resolved.is_some()
                    {
                        uses.namesake = Some(occurrence.range);
                    }
                }
                Site::OwnModule => {}
                Site::ImportOf(_) => uses.bare = true,
                Site::Use if occurrence.qualifier.is_some() => {
                    uses.qualified.push(whole_name(&occurrence))
                }
                Site::Use => uses.bare = true,
            }
        };
        walk(
            view.tree.root_node(),
            &view.source,
            &mut Vec::new(),
            &mut visit,
        );
        uses
    }

    /// How the destination writes a name that the function uses: the text,
    /// where it differs from the function's, and the module that the
    /// destination imports anew for it, which it can need for a name that keeps
    /// its text. `Err` holds why no text means there what the name means here.
    fn written_in_target(
        &self,
        declared: &BTreeMap<String, Declared>,
        source: &ModuleView,
        target: &ModuleView,
        function_name: &str,
        occurrence: &Occurrence,
        bound: &[&str],
    ) -> Result<(Option<String>, Option<String>), String> {
        let source_name = source.module.module_name.as_str();
        let target_name = target.module.module_name.as_str();
        let (namespace, name) = (occurrence.namespace, occurrence.name);
        let target_declares = declared[target_name].has(namespace, name);
        // An import of the destination that lets the name in bare, and is not of `module`
        let other_import_gives = |module: &str| {
            target.module.imports.iter().any(|import| {
                import.module_name != module
                    && self.import_exposes(declared, import, namespace, name)
            })
        };
        let Some(module) = self.resolve_occurrence(declared, source, occurrence, bound) else {
            if namespace == Namespace::Value && bound.contains(&name) {
                return Ok((None, None));
            }
            if occurrence.qualifier.is_some() {
                // A module of the default imports
                return Ok((None, None));
            }
            if !is_default_name(namespace, name) {
                return Err(format!(
                    "{} comes from no module that the language server knows, so it cannot tell how {} would name it",
                    name, target_name
                ));
            }
            if target_declares || other_import_gives("") {
                return Err(format!(
                    "{} names another {} in {}",
                    name, name, target_name
                ));
            }
            return Ok((None, None));
        };
        if module == source_name && namespace == Namespace::Value && name == function_name {
            return Ok((None, None));
        }
        if module == target_name {
            return Ok((occurrence.qualifier.map(|_| name.to_string()), None));
        }
        if module == source_name && !self.module_exposes(declared, module, namespace, name) {
            return Err(format!(
                "the function uses {}, which {} does not expose, so {} cannot reach it",
                name, source_name, target_name
            ));
        }
        if occurrence.qualifier.is_none()
            && !target_declares
            && !other_import_gives(module)
            && target.module.imports.iter().any(|import| {
                import.module_name == module
                    && self.import_exposes(declared, import, namespace, name)
            })
        {
            return Ok((None, None));
        }
        let (qualifier, import) = match qualifier_in(&target.module.imports, module) {
            Some(Qualified::As(qualifier)) => (qualifier, None),
            Some(Qualified::Anew(qualifier)) => {
                let default = DEFAULT_IMPORTS.iter().any(|(each, _)| *each == module);
                (qualifier, (!default).then(|| module.to_string()))
            }
            None => {
                return Err(format!(
                    "{} names other modules by {} as well, so {} would be ambiguous there",
                    target_name, module, name
                ))
            }
        };
        let written = format!("{}.{}", qualifier, name);
        let as_written = match occurrence.qualifier {
            Some(own) => format!("{}.{}", own, name),
            None => name.to_string(),
        };
        Ok(((written != as_written).then_some(written), import))
    }

    /// Why the destination cannot use an operator of the function: one that
    /// no default import gives, and that no import of the destination exposes
    /// by name or through an `exposing (..)` of a module that the old module
    /// takes operators from as well.
    fn operator_unreachable(
        &self,
        node: tree_sitter::Node,
        source: &ModuleView,
        target: &ModuleView,
    ) -> Option<String> {
        let mut operators = Vec::new();
        collect_kind(node, "operator_identifier", &mut operators);
        let exposed = |view: &ModuleView, module: &str, operator: &str| {
            let root = view.tree.root_node();
            let mut cursor = root.walk();
            let found = root
                .children(&mut cursor)
                .filter(|clause| clause.kind() == "import_clause")
                .filter(|clause| {
                    clause
                        .child_by_field_name("moduleName")
                        .is_some_and(|name| text(name, &view.source) == module)
                })
                .any(|clause| {
                    let mut listed = Vec::new();
                    collect_kind(clause, "operator_identifier", &mut listed);
                    listed
                        .iter()
                        .any(|each| text(*each, &view.source) == operator)
                });
            found
        };
        for operator in operators {
            let operator_text = text(operator, &source.source);
            if DEFAULT_OPERATORS.contains(&operator_text) {
                continue;
            }
            let reachable = target.module.imports.iter().any(|import| {
                exposed(target, &import.module_name, operator_text)
                    || (matches!(import.exposing, ExposingInfo::All)
                        && source.module.imports.iter().any(|own| {
                            own.module_name == import.module_name
                                && (matches!(own.exposing, ExposingInfo::All)
                                    || exposed(source, &own.module_name, operator_text))
                        }))
            });
            if !reachable {
                return Some(format!(
                    "at {} the function uses the operator {}, which no import of {} exposes",
                    self.place(&source.module.path, &range_of_node(operator)),
                    operator_text,
                    target.module.module_name
                ));
            }
        }
        None
    }

    /// The import cycle that the new imports would close, written as the
    /// chain of modules, or `None`. A module of the project that reaches the
    /// importer through the imports it has and the new ones closes one.
    fn closed_cycle(&self, new_edges: &[(String, String)]) -> Option<String> {
        let mut graph: BTreeMap<&str, BTreeSet<&str>> = BTreeMap::new();
        for module in self.modules.values() {
            let next = graph.entry(module.module_name.as_str()).or_default();
            for import in &module.imports {
                next.insert(import.module_name.as_str());
            }
        }
        for (from, to) in new_edges {
            graph.entry(from.as_str()).or_default().insert(to.as_str());
        }
        for (from, to) in new_edges {
            // The way from the imported module back to the importer, if any
            let mut came_from: BTreeMap<&str, &str> = BTreeMap::new();
            let mut pending = std::collections::VecDeque::from([to.as_str()]);
            while let Some(current) = pending.pop_front() {
                if current == from {
                    // Back from the importer to the imported module, then turned around
                    let mut chain = vec![from.as_str()];
                    while *chain.last()? != to.as_str() {
                        chain.push(came_from[chain.last()?]);
                    }
                    chain.reverse();
                    let mut written = format!("{} would import {}", from, to);
                    for module in &chain[1..] {
                        written.push_str(&format!(", which imports {}", module));
                    }
                    return Some(written);
                }
                for next in graph.get(current).into_iter().flatten() {
                    if *next != to.as_str() && !came_from.contains_key(next) {
                        came_from.insert(next, current);
                        pending.push_back(next);
                    }
                }
            }
        }
        None
    }
}

/// The name a top-level declaration gives a function: its type annotation or
/// its definition.
fn declared_name<'s>(node: tree_sitter::Node, source: &'s str) -> Option<&'s str> {
    match node.kind() {
        "type_annotation" => node
            .child_by_field_name("name")
            .map(|name| text(name, source)),
        "value_declaration" => node
            .child_by_field_name("functionDeclarationLeft")
            .and_then(|left| left.child(0))
            .map(|name| text(name, source)),
        _ => None,
    }
}

fn range_of_node(node: tree_sitter::Node) -> Range {
    let (start, end) = (node.start_position(), node.end_position());
    Range {
        start: Position::new(start.row as u32, start.column as u32),
        end: Position::new(end.row as u32, end.column as u32),
    }
}

fn contains(outer: &Range, inner: &Range) -> bool {
    let at = |position: &Position| (position.line, position.character);
    at(&outer.start) <= at(&inner.start) && at(&inner.end) <= at(&outer.end)
}

/// Whether the name at `range` is the record of a record update, as in
/// `{ record | field = 1 }`
fn is_record_base(view: &ModuleView, range: &Range) -> bool {
    let point = |position: &Position| {
        tree_sitter::Point::new(position.line as usize, position.character as usize)
    };
    view.tree
        .root_node()
        .descendant_for_point_range(point(&range.start), point(&range.end))
        .and_then(|node| node.parent())
        .is_some_and(|parent| parent.kind() == "record_base_identifier")
}

/// The place of a name with its qualifier, which a qualified name has right
/// in front of it, with no space between.
fn whole_name(occurrence: &Occurrence) -> Range {
    let mut range = occurrence.range;
    if let Some(qualifier) = occurrence.qualifier {
        range.start.character -= qualifier.len() as u32 + 1;
    }
    range
}

/// Every node of `kind` below `node`
fn collect_kind<'t>(node: tree_sitter::Node<'t>, kind: &str, out: &mut Vec<tree_sitter::Node<'t>>) {
    if node.kind() == kind {
        out.push(node);
    }
    let mut cursor = node.walk();
    for child in node.children(&mut cursor) {
        collect_kind(child, kind, out);
    }
}

/// The names that patterns and the declarations of a `let` bind below
/// `node`, which no top-level name of the module may share.
fn local_binders(node: tree_sitter::Node, source: &str, out: &mut Vec<(String, Range)>) {
    let top_level = node.parent().is_some_and(|parent| parent.kind() == "file");
    match node.kind() {
        "lower_pattern" => out.push((text(node, source).to_string(), range_of_node(node))),
        "value_declaration" if !top_level => {
            if let Some(name) = node
                .child_by_field_name("functionDeclarationLeft")
                .and_then(|left| left.child(0))
            {
                out.push((text(name, source).to_string(), range_of_node(name)));
            }
        }
        _ => {}
    }
    let mut cursor = node.walk();
    for child in node.children(&mut cursor) {
        local_binders(child, source, out);
    }
}

/// The qualifier under which a module with these imports names `module`: the
/// first import of it whose qualifier no import of another module shares, or
/// the whole name, or the default qualifier, for one it would import anew.
/// `None` where another module goes by every such qualifier.
fn qualifier_in(imports: &[ImportInfo], module: &str) -> Option<Qualified> {
    let qualifier_of = |import: &ImportInfo| {
        import
            .alias
            .clone()
            .unwrap_or_else(|| import.module_name.clone())
    };
    let shared = |qualifier: &str| {
        imports
            .iter()
            .any(|import| import.module_name != module && qualifier_of(import) == qualifier)
    };
    let own: Vec<String> = imports
        .iter()
        .filter(|import| import.module_name == module)
        .map(qualifier_of)
        .collect();
    if !own.is_empty() {
        return own
            .into_iter()
            .find(|qualifier| !shared(qualifier))
            .map(Qualified::As);
    }
    let anew = DEFAULT_IMPORTS
        .iter()
        .find(|(each, _)| *each == module)
        .map_or(module, |(_, qualifier)| qualifier);
    (!shared(anew)).then(|| Qualified::Anew(anew.to_string()))
}

/// Whether a module imports `module`
fn imports(view: &ModuleView, module: &str) -> bool {
    view.module
        .imports
        .iter()
        .any(|import| import.module_name == module)
}

#[cfg(test)]
mod tests {
    use super::super::test_support::{edited, project};
    use super::*;
    use std::collections::HashMap;
    use tempfile::TempDir;

    /// The plan of moving `name` from one file below src to another, or the refusal
    fn plan(
        dir: &TempDir,
        workspace: &Workspace,
        from: &str,
        name: &str,
        to: &str,
    ) -> Result<MovePlan, String> {
        let path = |file: &str| dir.path().join("src").join(file);
        workspace.plan_move(&path(from), name, &path(to)).unwrap()
    }

    /// The text of a file below src with the name edits of a plan
    fn rewritten(dir: &TempDir, plan: &MovePlan, file: &str) -> String {
        let changes: HashMap<Url, Vec<TextEdit>> = plan
            .edits
            .iter()
            .map(|(path, edits)| (Url::from_file_path(path).unwrap(), edits.clone()))
            .collect();
        edited(dir, &changes, file)
    }

    fn user<'p>(dir: &TempDir, plan: &'p MovePlan, file: &str) -> Option<&'p MoveUser> {
        let path = dir.path().join("src").join(file);
        plan.users.iter().find(|user| Path::new(&user.path) == path)
    }

    const SESSION: &str = "module Session exposing (Status(..), yesNo)\n\n\ntype Status\n    = Active\n    | Gone\n\n\nyesNo : Bool -> String\nyesNo answer =\n    if answer then\n        \"yes\"\n\n    else\n        \"no\"\n";
    const MODEL: &str = "module Model exposing (Model)\n\nimport Session\n\n\ntype alias Model =\n    { status : Session.Status\n    }\n";

    #[test]
    fn test_the_old_module_imports_the_function_only_where_it_calls_it() {
        let (dir, workspace) = project(&[("Session.elm", SESSION), ("Model.elm", MODEL)]);
        let moved = plan(&dir, &workspace, "Session.elm", "yesNo", "Model.elm").unwrap();
        assert!(!moved.called_at_home);
        assert!(moved.users.is_empty());
        assert!(moved.target_imports.is_empty());
        assert!(moved.edits.is_empty());

        // Where it calls the function, the import of it would close a cycle with Model's import of Session
        let calling = SESSION.replace(
            "    | Gone\n",
            "    | Gone\n\n\nshown : Status -> String\nshown status =\n    yesNo (status == Active)\n",
        );
        let (dir, workspace) = project(&[("Session.elm", &calling), ("Model.elm", MODEL)]);
        let refused = plan(&dir, &workspace, "Session.elm", "yesNo", "Model.elm").unwrap_err();
        assert_eq!(
            refused,
            "it would close an import cycle: Session would import Model, which imports Session"
        );
    }

    const LABEL: &str = "module Label exposing (Tone(..), label, plain)\n\nimport Html exposing (Html, text)\nimport Html.Attributes as Attr\n\n\ntype Tone\n    = Loud\n    | Soft\n\n\nlabel : Tone -> String -> Html msg\nlabel tone words =\n    case tone of\n        Loud ->\n            Html.span [ Attr.class \"loud\" ] [ text (String.toUpper words) ]\n\n        Soft ->\n            let\n                quiet =\n                    \\text -> String.toLower text\n            in\n            plain { shown = quiet words }.shown\n\n\nplain : String -> Html msg\nplain words =\n    text words\n";
    const TEXT: &str = "module Text exposing (shout)\n\n\nshout : String -> String\nshout words =\n    String.toUpper words\n";

    #[test]
    fn test_a_moved_function_names_what_it_uses_through_the_imports_of_its_new_module() {
        let (dir, workspace) = project(&[("Label.elm", LABEL), ("Text.elm", TEXT)]);
        let moved = plan(&dir, &workspace, "Label.elm", "label", "Text.elm").unwrap();
        // The names of its old module and of its imports get the whole name of their module. A local
        // binding keeps its name, and so does what the default imports give.
        let expected = LABEL
            .replace(
                "label : Tone -> String -> Html msg",
                "label : Label.Tone -> String -> Html.Html msg",
            )
            .replace("        Loud ->", "        Label.Loud ->")
            .replace("        Soft ->", "        Label.Soft ->")
            .replace(
                "[ Attr.class \"loud\" ] [ text (",
                "[ Html.Attributes.class \"loud\" ] [ Html.text (",
            )
            .replace("            plain {", "            Label.plain {");
        assert_eq!(rewritten(&dir, &moved, "Label.elm"), expected);
        assert_eq!(moved.target_imports, ["Html", "Html.Attributes", "Label"]);
    }

    #[test]
    fn test_a_moved_function_keeps_a_name_that_an_import_of_its_new_module_gives_bare() {
        let text = TEXT.replace(
            "module Text exposing (shout)\n",
            "module Text exposing (shout)\n\nimport Html exposing (Html, text)\nimport Html.Attributes as A\nimport Label as L exposing (Tone(..))\n",
        );
        let (dir, workspace) = project(&[("Label.elm", LABEL), ("Text.elm", &text)]);
        let moved = plan(&dir, &workspace, "Label.elm", "label", "Text.elm").unwrap();
        let expected = LABEL
            .replace("[ Attr.class", "[ A.class")
            .replace("            plain {", "            L.plain {");
        assert_eq!(rewritten(&dir, &moved, "Label.elm"), expected);
        assert!(moved.target_imports.is_empty());
    }

    #[test]
    fn test_a_move_is_refused_where_its_new_module_cannot_reach_a_name_of_it() {
        // A function of the old module that it does not expose
        let hidden = LABEL.replace("(Tone(..), label, plain)", "(Tone(..), label)");
        let (dir, workspace) = project(&[("Label.elm", &hidden), ("Text.elm", TEXT)]);
        let refused = plan(&dir, &workspace, "Label.elm", "label", "Text.elm").unwrap_err();
        assert_eq!(refused, "at src/Label.elm:23 the function uses plain, which Label does not expose, so Text cannot reach it");

        // A variant of a type that it exposes without its variants
        let closed = LABEL.replace("(Tone(..), label, plain)", "(Tone, label, plain)");
        let (dir, workspace) = project(&[("Label.elm", &closed), ("Text.elm", TEXT)]);
        let refused = plan(&dir, &workspace, "Label.elm", "label", "Text.elm").unwrap_err();
        assert_eq!(refused, "at src/Label.elm:15 the function uses Loud, which Label does not expose, so Text cannot reach it");

        // A binding of the function shares a name with a function of the new module
        let quiet = format!("{}\n\nquiet : String\nquiet =\n    \"\"\n", TEXT.trim_end());
        let (dir, workspace) = project(&[("Label.elm", LABEL), ("Text.elm", &quiet)]);
        let refused = plan(&dir, &workspace, "Label.elm", "label", "Text.elm").unwrap_err();
        assert_eq!(refused, "at src/Label.elm:20 the function binds quiet, which Text declares, and the compiler does not let one hide the other");

        // The new module names another function of the name bare
        let other = "module Other exposing (label)\n\n\nlabel : String\nlabel =\n    \"\"\n";
        let using = TEXT
            .replace(
                "module Text exposing (shout)\n",
                "module Text exposing (shout)\n\nimport Other exposing (label)\n",
            )
            .replace("String.toUpper words", "String.toUpper (words ++ label)");
        let (dir, workspace) = project(&[
            ("Label.elm", LABEL),
            ("Text.elm", &using),
            ("Other.elm", other),
        ]);
        let refused = plan(&dir, &workspace, "Label.elm", "label", "Text.elm").unwrap_err();
        assert_eq!(refused, "at src/Text.elm:8 Text names another label, which the moved function would take the place of");

        // A qualifier that the new module gives another module as well
        let shared = TEXT.replace(
            "module Text exposing (shout)\n",
            "module Text exposing (shout)\n\nimport Other as Html\n",
        );
        let (dir, workspace) = project(&[
            ("Label.elm", LABEL),
            ("Text.elm", &shared),
            ("Other.elm", other),
        ]);
        let refused = plan(&dir, &workspace, "Label.elm", "label", "Text.elm").unwrap_err();
        assert_eq!(refused, "at src/Label.elm:12 Text names other modules by Html as well, so Html would be ambiguous there");
    }

    #[test]
    fn test_every_call_of_a_moved_function_names_its_new_module() {
        let price = "module Price exposing (Price, format)\n\n\ntype alias Price =\n    Int\n\n\nformat : Int -> String\nformat cents =\n    String.fromInt cents ++ \" cents\"\n";
        // Through the module's name, through an alias, bare through the exposing list and through (..),
        // and in a let, a lambda and a case
        let shop = "module Shop exposing (a, b)\n\nimport Price\nimport Text as T\n\n\na : Int -> String\na n =\n    let\n        shown =\n            Price.format n\n    in\n    T.shout shown\n\n\nb : Maybe Int -> String\nb m =\n    case m of\n        Just n ->\n            (\\k -> Price.format k) n\n\n        Nothing ->\n            \"\"\n";
        let till = "module Till exposing (c)\n\nimport Price as P\n\n\nc : Int -> String\nc =\n    P.format\n";
        let desk = "module Desk exposing (d, e)\n\nimport Price exposing (format)\nimport Price as Other\n\n\nd : String\nd =\n    format 1\n\n\ne : String\ne =\n    Other.format 2\n";
        let all = "module All exposing (f)\n\nimport Price exposing (..)\n\n\nf : Price -> String\nf =\n    format\n";
        let (dir, workspace) = project(&[
            ("Price.elm", price),
            ("Text.elm", TEXT),
            ("Shop.elm", shop),
            ("Till.elm", till),
            ("Desk.elm", desk),
            ("All.elm", all),
        ]);
        let moved = plan(&dir, &workspace, "Price.elm", "format", "Text.elm").unwrap();
        assert_eq!(
            rewritten(&dir, &moved, "Shop.elm"),
            shop.replace("Price.format", "T.format")
        );
        assert_eq!(
            rewritten(&dir, &moved, "Till.elm"),
            till.replace("P.format", "Text.format")
        );
        assert_eq!(
            rewritten(&dir, &moved, "Desk.elm"),
            desk.replace("Other.format", "Text.format")
        );
        assert_eq!(rewritten(&dir, &moved, "All.elm"), all);
        let flags = |file| user(&dir, &moved, file).map(|user| (user.bare, user.needs_import));
        assert_eq!(flags("Shop.elm"), Some((false, false)));
        assert_eq!(flags("Till.elm"), Some((false, true)));
        assert_eq!(flags("Desk.elm"), Some((true, false)));
        assert_eq!(flags("All.elm"), Some((true, false)));
        assert_eq!(flags("Text.elm"), None);

        // The new module's own calls name the function bare
        let calling = TEXT
            .replace(
                "module Text exposing (shout)\n",
                "module Text exposing (shout)\n\nimport Price as P\n",
            )
            .replace(
                "String.toUpper words",
                "String.toUpper (words ++ P.format 1)",
            );
        let (dir, workspace) = project(&[("Price.elm", price), ("Text.elm", &calling)]);
        let moved = plan(&dir, &workspace, "Price.elm", "format", "Text.elm").unwrap();
        assert_eq!(
            rewritten(&dir, &moved, "Text.elm"),
            calling.replace("P.format 1", "format 1")
        );
    }

    #[test]
    fn test_a_moved_function_of_a_port_module_names_its_records_and_ports_through_the_new_module() {
        let ports = "port module Ports exposing (Config, defaults, send, settings)\n\n\ntype alias Config =\n    { inner : { size : Int }, name : String }\n\n\nport send : String -> Cmd msg\n\n\ndefaults : Config\ndefaults =\n    { inner = { size = 1 }, name = \"\" }\n\n\nsettings : Int -> ( Config, Cmd msg )\nsettings size =\n    ( Config { size = size } \"big\", send \"go\" )\n";
        let (dir, workspace) = project(&[("Ports.elm", ports), ("Text.elm", TEXT)]);
        let moved = plan(&dir, &workspace, "Ports.elm", "settings", "Text.elm").unwrap();
        assert_eq!(
            rewritten(&dir, &moved, "Ports.elm"),
            ports
                .replace(
                    "settings : Int -> ( Config,",
                    "settings : Int -> ( Ports.Config,"
                )
                .replace("( Config { size", "( Ports.Config { size")
                .replace(", send \"go\"", ", Ports.send \"go\"")
        );
        assert_eq!(moved.target_imports, ["Ports"]);

        // The record of an update cannot take the qualifier that the new module would need
        let updating = ports.replace(
            "( Config { size = size } \"big\", send \"go\" )",
            "( { defaults | inner = { size = size } }, Cmd.none )",
        );
        let (dir, workspace) = project(&[("Ports.elm", &updating), ("Text.elm", TEXT)]);
        assert_eq!(
            plan(&dir, &workspace, "Ports.elm", "settings", "Text.elm").unwrap_err(),
            "at src/Ports.elm:18 the function updates the record defaults, which the compiler takes only by a bare name, and Text has to write it Ports.defaults"
        );
        // Where the new module's import gives it bare, it stays bare
        let exposing = TEXT.replace(
            "module Text exposing (shout)\n",
            "module Text exposing (shout)\n\nimport Ports exposing (Config, defaults)\n",
        );
        let (dir, workspace) = project(&[("Ports.elm", &updating), ("Text.elm", &exposing)]);
        let moved = plan(&dir, &workspace, "Ports.elm", "settings", "Text.elm").unwrap();
        assert!(moved.edits.is_empty());
        assert!(moved.target_imports.is_empty());
    }

    #[test]
    fn test_a_move_is_refused_where_a_new_import_closes_a_cycle_through_a_third_module() {
        // Text would import Shop for a name that the function takes from it, which is no cycle until Shop imports Text
        let price = "module Price exposing (format)\n\nimport Shop\n\n\nformat : Int -> String\nformat cents =\n    Shop.unit cents\n";
        let shop = "module Shop exposing (unit)\n\n\nunit : Int -> String\nunit cents =\n    String.fromInt cents\n";
        let text = "module Text exposing (shout)\n\nimport Till\n\n\nshout : String -> String\nshout words =\n    Till.loud words\n";
        let till = "module Till exposing (loud)\n\nimport Shop\n\n\nloud : String -> String\nloud words =\n    words ++ Shop.unit 0\n";
        let (dir, workspace) = project(&[
            ("Price.elm", price),
            ("Shop.elm", shop),
            ("Text.elm", text),
            ("Till.elm", till),
        ]);
        assert_eq!(
            plan(&dir, &workspace, "Price.elm", "format", "Text.elm")
                .unwrap()
                .target_imports,
            ["Shop"]
        );

        let calling = shop.replace(
            "module Shop exposing (unit)\n",
            "module Shop exposing (unit)\n\nimport Text\n",
        );
        let (dir, workspace) = project(&[
            ("Price.elm", price),
            ("Shop.elm", &calling),
            ("Text.elm", text),
            ("Till.elm", till),
        ]);
        assert_eq!(
            plan(&dir, &workspace, "Price.elm", "format", "Text.elm").unwrap_err(),
            "it would close an import cycle: Text would import Shop, which imports Text"
        );
    }

    #[test]
    fn test_a_move_is_refused_where_the_new_module_lacks_an_operator_of_the_function() {
        let parse = "module Parse exposing (Parser, (|=), succeed)\n\n\ntype Parser a\n    = Parser a\n\n\n(|=) : Parser (a -> b) -> Parser a -> Parser b\n(|=) (Parser f) (Parser a) =\n    Parser (f a)\n\n\nsucceed : a -> Parser a\nsucceed =\n    Parser\n";
        let number = "module Number exposing (pair)\n\nimport Parse exposing (Parser, succeed, (|=))\n\n\npair : Parser ( Int, Int )\npair =\n    succeed Tuple.pair |= succeed 1 |= succeed 2\n";
        let (dir, workspace) = project(&[
            ("Parse.elm", parse),
            ("Number.elm", number),
            ("Text.elm", TEXT),
        ]);
        assert_eq!(
            plan(&dir, &workspace, "Number.elm", "pair", "Text.elm").unwrap_err(),
            "at src/Number.elm:8 the function uses the operator |=, which no import of Text exposes"
        );
        let importing = TEXT.replace(
            "module Text exposing (shout)\n",
            "module Text exposing (shout)\n\nimport Parse exposing ((|=))\n",
        );
        let (dir, workspace) = project(&[
            ("Parse.elm", parse),
            ("Number.elm", number),
            ("Text.elm", &importing),
        ]);
        let moved = plan(&dir, &workspace, "Number.elm", "pair", "Text.elm").unwrap();
        assert_eq!(
            rewritten(&dir, &moved, "Number.elm"),
            number
                .replace("pair : Parser", "pair : Parse.Parser")
                .replace(
                    "succeed Tuple.pair |= succeed 1 |= succeed 2",
                    "Parse.succeed Tuple.pair |= Parse.succeed 1 |= Parse.succeed 2"
                )
        );
    }
}
