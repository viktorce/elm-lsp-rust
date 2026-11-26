//! Name resolution for the renames.
//!
//! A name in Elm source is resolved the way the compiler resolves it: a
//! qualified name through the import whose module name or alias is its
//! qualifier, an unqualified one through the local bindings around it, then
//! the declarations of its own module, then the imports that expose it.
//! Values, types and constructors are three namespaces, so `Lookup` the type
//! and `Lookup` the variant are different names. Matching a use by its text
//! alone would catch every namesake, which is why the renames go through here.

use std::collections::{BTreeMap, HashMap, HashSet};
use tower_lsp::lsp_types::*;

use super::{ElmModule, ExposingInfo, ImportInfo, SymbolReference, Workspace};

/// The kind of thing a name names. Each kind has names of its own.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum Namespace {
    /// Functions, constants and ports
    Value,
    /// Custom types and type aliases
    Type,
    /// Variants, and the constructor of a record type alias
    Constructor,
}

/// A top-level declaration of a module, which a rename starts from.
#[derive(Debug, Clone, Copy)]
pub struct Target<'a> {
    pub module: &'a str,
    pub name: &'a str,
    pub namespace: Namespace,
}

/// The top-level names a module declares.
#[derive(Debug, Default)]
pub(super) struct Declared {
    values: HashSet<String>,
    types: HashSet<String>,
    constructors: HashSet<String>,
    /// The constructors each type brings along: the variants of a custom
    /// type, and the alias itself for a record type alias
    constructors_of: HashMap<String, Vec<String>>,
    /// The record type aliases. Listed in an exposing list without `(..)`,
    /// one lets its constructor out, and a custom type does not.
    record_aliases: HashSet<String>,
}

impl Declared {
    pub(super) fn of(root: tree_sitter::Node, source: &str) -> Self {
        let mut declared = Declared::default();
        let mut cursor = root.walk();
        for node in root.children(&mut cursor) {
            match node.kind() {
                "value_declaration" => {
                    let name = node
                        .child_by_field_name("functionDeclarationLeft")
                        .and_then(|left| left.child(0));
                    if let Some(name) = name {
                        declared.values.insert(text(name, source).to_string());
                    }
                }
                "port_annotation" => {
                    if let Some(name) = node.child_by_field_name("name") {
                        declared.values.insert(text(name, source).to_string());
                    }
                }
                "type_declaration" => {
                    let Some(name) = node.child_by_field_name("name") else {
                        continue;
                    };
                    let name = text(name, source).to_string();
                    let mut variants = Vec::new();
                    let mut inner = node.walk();
                    for variant in node.children_by_field_name("unionVariant", &mut inner) {
                        if let Some(variant_name) = variant.child_by_field_name("name") {
                            variants.push(text(variant_name, source).to_string());
                        }
                    }
                    declared.constructors.extend(variants.iter().cloned());
                    declared.constructors_of.insert(name.clone(), variants);
                    declared.types.insert(name);
                }
                "type_alias_declaration" => {
                    let Some(name) = node.child_by_field_name("name") else {
                        continue;
                    };
                    let name = text(name, source).to_string();
                    if is_record_alias(node) {
                        declared.record_aliases.insert(name.clone());
                        declared.constructors.insert(name.clone());
                        declared
                            .constructors_of
                            .insert(name.clone(), vec![name.clone()]);
                    }
                    declared.types.insert(name);
                }
                _ => {}
            }
        }
        declared
    }

    /// All the variants of the custom type that has this variant
    fn variants_alongside(&self, variant: &str) -> Option<&Vec<String>> {
        self.constructors_of
            .iter()
            .find(|(type_name, constructors)| {
                !self.record_aliases.contains(*type_name)
                    && constructors
                        .iter()
                        .any(|constructor| constructor == variant)
            })
            .map(|(_, constructors)| constructors)
    }

    pub(super) fn has(&self, namespace: Namespace, name: &str) -> bool {
        match namespace {
            Namespace::Value => self.values.contains(name),
            Namespace::Type => self.types.contains(name),
            Namespace::Constructor => self.constructors.contains(name),
        }
    }
}

/// True for `type alias A = { ... }`, which makes a constructor `A`. An
/// alias of an extensible record makes none.
fn is_record_alias(node: tree_sitter::Node) -> bool {
    let Some(expression) = node.child_by_field_name("typeExpression") else {
        return false;
    };
    let mut cursor = expression.walk();
    let parts: Vec<_> = expression.named_children(&mut cursor).collect();
    matches!(parts.as_slice(), [record] if record.kind() == "record_type"
        && record.child_by_field_name("baseRecord").is_none())
}

pub(super) fn text<'s>(node: tree_sitter::Node, source: &'s str) -> &'s str {
    &source[node.byte_range()]
}

fn range_of(node: tree_sitter::Node) -> Range {
    let start = node.start_position();
    let end = node.end_position();
    Range {
        start: Position::new(start.row as u32, start.column as u32),
        end: Position::new(end.row as u32, end.column as u32),
    }
}

/// Where a name stands, which decides how it resolves.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum Site<'s> {
    /// A use in an expression, a pattern or a type
    Use,
    /// The name in a top-level declaration, or in the module's exposing list
    OwnModule,
    /// An entry in the exposing list of an import of this module
    ImportOf(&'s str),
}

/// One name in a module's source.
#[derive(Debug, Clone, Copy)]
pub(super) struct Occurrence<'s> {
    pub(super) namespace: Namespace,
    pub(super) qualifier: Option<&'s str>,
    pub(super) name: &'s str,
    /// The name alone, without its qualifier
    pub(super) range: Range,
    pub(super) site: Site<'s>,
}

/// The names that patterns bind, which hide a value of the same name in the
/// expressions they reach.
fn pattern_binders<'s>(node: tree_sitter::Node, source: &'s str, out: &mut Vec<&'s str>) {
    if node.kind() == "lower_pattern" {
        out.push(text(node, source));
        return;
    }
    let mut cursor = node.walk();
    for child in node.children(&mut cursor) {
        pattern_binders(child, source, out);
    }
}

/// The names a `let` binds for all of its declarations and its body.
fn let_binders<'s>(node: tree_sitter::Node, source: &'s str, out: &mut Vec<&'s str>) {
    let mut cursor = node.walk();
    for declaration in node.children_by_field_name("valueDeclaration", &mut cursor) {
        if let Some(left) = declaration.child_by_field_name("functionDeclarationLeft") {
            if let Some(name) = left.child(0) {
                out.push(text(name, source));
            }
        } else if let Some(pattern) = declaration.child_by_field_name("pattern") {
            pattern_binders(pattern, source, out);
        }
    }
}

/// A qualified or unqualified name: the qualifier, if any, and the last part.
fn split_qid<'s>(
    qid: tree_sitter::Node<'s>,
    source: &'s str,
) -> Option<(Option<&'s str>, tree_sitter::Node<'s>)> {
    let last = qid.child(qid.child_count().checked_sub(1)?)?;
    let qualifier = (last.start_byte() > qid.start_byte())
        .then(|| source[qid.start_byte()..last.start_byte()].trim_end_matches('.'));
    Some((qualifier, last))
}

/// The first place below `node` that binds the name locally: a parameter,
/// a variable of a pattern, or a declaration in a `let`
fn local_binding(node: tree_sitter::Node, source: &str, name: &str) -> Option<Range> {
    let top_level = node.parent().is_some_and(|parent| parent.kind() == "file");
    match node.kind() {
        "lower_pattern" if text(node, source) == name => return Some(range_of(node)),
        "value_declaration" if !top_level => {
            let declared = node
                .child_by_field_name("functionDeclarationLeft")
                .and_then(|left| left.child(0))
                .filter(|declared| text(*declared, source) == name);
            if let Some(declared) = declared {
                return Some(range_of(declared));
            }
        }
        _ => {}
    }
    let mut cursor = node.walk();
    let found = node
        .children(&mut cursor)
        .find_map(|child| local_binding(child, source, name));
    found
}

/// Visit every name of a module with the local bindings in force where it
/// stands. A local binding can only hide a value.
pub(super) fn walk<'s>(
    node: tree_sitter::Node<'s>,
    source: &'s str,
    bound: &mut Vec<&'s str>,
    visit: &mut dyn FnMut(Occurrence<'s>, &[&'s str]),
) {
    let mut emit =
        |namespace, qualifier, name_node: tree_sitter::Node<'s>, site, bound: &[&'s str]| {
            visit(
                Occurrence {
                    namespace,
                    qualifier,
                    name: text(name_node, source),
                    range: range_of(name_node),
                    site,
                },
                bound,
            )
        };
    let depth = bound.len();
    let top_level = node.parent().is_some_and(|parent| parent.kind() == "file");

    match node.kind() {
        "value_expr" => {
            if let Some(qid) = node.child_by_field_name("name") {
                let namespace = if qid.kind() == "value_qid" {
                    Namespace::Value
                } else {
                    Namespace::Constructor
                };
                if let Some((qualifier, name)) = split_qid(qid, source) {
                    emit(namespace, qualifier, name, Site::Use, bound);
                }
            }
            return;
        }
        "record_base_identifier" => {
            // In a record type it is a type variable
            if node
                .parent()
                .is_some_and(|parent| parent.kind() == "record_expr")
            {
                if let Some(name) = node.child(0) {
                    emit(Namespace::Value, None, name, Site::Use, bound);
                }
            }
            return;
        }
        "type_annotation" => {
            if let Some(name) = node.child_by_field_name("name") {
                let site = if top_level {
                    Site::OwnModule
                } else {
                    Site::Use
                };
                emit(Namespace::Value, None, name, site, bound);
            }
        }
        "type_ref" => {
            if let Some(qid) = node
                .child(0)
                .filter(|child| child.kind() == "upper_case_qid")
            {
                if let Some((qualifier, name)) = split_qid(qid, source) {
                    emit(Namespace::Type, qualifier, name, Site::Use, bound);
                }
            }
        }
        "union_pattern" | "nullary_constructor_argument_pattern" => {
            let qid = node.child_by_field_name("constructor").or_else(|| {
                node.child(0)
                    .filter(|child| child.kind() == "upper_case_qid")
            });
            if let Some((qualifier, name)) = qid.and_then(|qid| split_qid(qid, source)) {
                emit(Namespace::Constructor, qualifier, name, Site::Use, bound);
            }
        }
        "union_variant" => {
            if let Some(name) = node.child_by_field_name("name") {
                emit(Namespace::Constructor, None, name, Site::OwnModule, bound);
            }
        }
        "type_declaration" | "type_alias_declaration" => {
            if let Some(name) = node.child_by_field_name("name") {
                emit(Namespace::Type, None, name, Site::OwnModule, bound);
                if node.kind() == "type_alias_declaration" && is_record_alias(node) {
                    emit(Namespace::Constructor, None, name, Site::OwnModule, bound);
                }
            }
        }
        "port_annotation" => {
            if let Some(name) = node.child_by_field_name("name") {
                emit(Namespace::Value, None, name, Site::OwnModule, bound);
            }
        }
        "module_declaration" | "import_clause" => {
            let site = if node.kind() == "module_declaration" {
                Site::OwnModule
            } else {
                match node.child_by_field_name("moduleName") {
                    Some(module) => Site::ImportOf(text(module, source)),
                    None => return,
                }
            };
            if let Some(list) = node.child_by_field_name("exposing") {
                let mut cursor = list.walk();
                for entry in list.named_children(&mut cursor) {
                    let (namespace, kind) = match entry.kind() {
                        "exposed_value" => (Namespace::Value, "lower_case_identifier"),
                        "exposed_type" => (Namespace::Type, "upper_case_identifier"),
                        _ => continue,
                    };
                    let mut inner = entry.walk();
                    let name = entry
                        .children(&mut inner)
                        .find(|child| child.kind() == kind);
                    if let Some(name) = name {
                        emit(namespace, None, name, site, bound);
                    }
                }
            }
            return;
        }
        "value_declaration" => {
            if let Some(left) = node.child_by_field_name("functionDeclarationLeft") {
                let mut cursor = left.walk();
                for (index, child) in left.children(&mut cursor).enumerate() {
                    if index == 0 {
                        if top_level {
                            emit(Namespace::Value, None, child, Site::OwnModule, bound);
                        }
                    } else {
                        pattern_binders(child, source, bound);
                    }
                }
            }
        }
        "let_in_expr" => let_binders(node, source, bound),
        "anonymous_function_expr" => {
            let mut cursor = node.walk();
            for param in node.children_by_field_name("param", &mut cursor) {
                pattern_binders(param, source, bound);
            }
        }
        "case_of_branch" => {
            if let Some(pattern) = node.child_by_field_name("pattern") {
                pattern_binders(pattern, source, bound);
            }
        }
        _ => {}
    }

    let mut cursor = node.walk();
    for child in node.children(&mut cursor) {
        walk(child, source, bound, visit);
    }
    bound.truncate(depth);
}

/// What the rename of a target finds in one module.
#[derive(Default)]
struct Findings {
    /// The uses of the target that are written without a qualifier, each with
    /// the local bindings in force there
    unqualified: Vec<(Range, Vec<String>)>,
    /// Every place that names the target
    uses: Vec<Range>,
    /// Unqualified uses of the new name that no local binding holds
    new_name_uses: Vec<Range>,
}

/// One module as the resolver sees it.
pub(super) struct ModuleView<'w> {
    pub(super) module: &'w ElmModule,
    pub(super) uri: Url,
    pub(super) tree: tree_sitter::Tree,
    pub(super) source: String,
}

/// The places in one module that name a target, with the text and the syntax
/// tree that they were read from.
pub struct ModuleUses {
    pub uri: Url,
    pub module_name: String,
    pub source: String,
    pub tree: tree_sitter::Tree,
    /// Each place, and whether it is the name in the target's declaration
    pub places: Vec<(Range, bool)>,
}

/// The places in one module that name any of several targets
pub struct ModuleUsesOfEach {
    pub uri: Url,
    pub module_name: String,
    pub source: String,
    pub tree: tree_sitter::Tree,
    /// Each place, the index of the target that it names, and whether it is
    /// the name in that target's declaration
    pub places: Vec<(usize, Range, bool)>,
    /// For each variant that the module names and the project declares, by
    /// where its name begins, all the variants of its type
    pub variants_of: BTreeMap<Position, Vec<String>>,
}

/// Whether the name at this place is the one that a top-level declaration
/// declares, rather than a use or an entry of an exposing list
fn is_declared_at(tree: &tree_sitter::Tree, range: &Range) -> bool {
    let point = |position: Position| {
        tree_sitter::Point::new(position.line as usize, position.character as usize)
    };
    tree.root_node()
        .descendant_for_point_range(point(range.start), point(range.end))
        .and_then(|name| name.parent())
        .is_some_and(|parent| {
            matches!(
                parent.kind(),
                "type_declaration"
                    | "type_alias_declaration"
                    | "union_variant"
                    | "port_annotation"
                    | "function_declaration_left"
            )
        })
}

/// Whether the position lies in the range. Its end counts, so a cursor right
/// behind the last letter of a name still names it.
fn contains(range: &Range, position: Position) -> bool {
    range.start <= position && position <= range.end
}

/// The top-level names that each module declares, by the module's name
fn declarations(views: &[ModuleView]) -> BTreeMap<String, Declared> {
    views
        .iter()
        .map(|view| {
            (
                view.module.module_name.clone(),
                Declared::of(view.tree.root_node(), &view.source),
            )
        })
        .collect()
}

impl Workspace {
    /// The project's modules with their syntax trees, in the order of their
    /// paths, so that every answer comes out the same. Evergreen snapshots
    /// are migrations of old versions and keep their names.
    pub(super) fn module_views(&self) -> anyhow::Result<Vec<ModuleView<'_>>> {
        let mut views = Vec::new();
        for (module, uri) in self.iter_non_evergreen_modules() {
            let (tree, source) = match (
                self.type_checker.get_tree(uri.as_str()),
                self.type_checker.get_source(uri.as_str()),
            ) {
                (Some(tree), Some(source)) => (tree.clone(), source.to_string()),
                _ => {
                    let source = std::fs::read_to_string(&module.path)?;
                    let tree = self.parser.parse(&source).ok_or_else(|| {
                        anyhow::anyhow!("{} could not be parsed", module.path.display())
                    })?;
                    (tree, source)
                }
            };
            views.push(ModuleView {
                module,
                uri,
                tree,
                source,
            });
        }
        views.sort_by(|a, b| a.module.path.cmp(&b.module.path));
        Ok(views)
    }

    /// Whether `module` lets other modules see the name. For a package module
    /// the index knows its declarations and not its exposing list, and a
    /// package exposes its constructors through types the index does not
    /// list them with.
    pub(super) fn module_exposes(
        &self,
        declared: &BTreeMap<String, Declared>,
        module: &str,
        namespace: Namespace,
        name: &str,
    ) -> bool {
        let Some(own) = declared.get(module) else {
            let qualified = format!("{}.{}", module, name);
            return self
                .external_symbols
                .get(&qualified)
                .is_some_and(|symbols| {
                    symbols.iter().any(|symbol| match namespace {
                        Namespace::Value => {
                            matches!(symbol.kind, SymbolKind::FUNCTION | SymbolKind::INTERFACE)
                        }
                        Namespace::Type => {
                            matches!(symbol.kind, SymbolKind::ENUM | SymbolKind::STRUCT)
                        }
                        Namespace::Constructor => false,
                    })
                });
        };
        let exposing = match self.modules.get(module) {
            Some(elm_module) => &elm_module.exposing,
            None => return false,
        };
        match exposing {
            ExposingInfo::All => own.has(namespace, name),
            ExposingInfo::Explicit(listed) => exposed_in(listed, own, namespace, name),
        }
    }

    /// Whether an import makes the name usable without a qualifier.
    pub(super) fn import_exposes(
        &self,
        declared: &BTreeMap<String, Declared>,
        import: &ImportInfo,
        namespace: Namespace,
        name: &str,
    ) -> bool {
        match &import.exposing {
            ExposingInfo::All => {
                self.module_exposes(declared, &import.module_name, namespace, name)
            }
            ExposingInfo::Explicit(listed) => match declared.get(&import.module_name) {
                Some(own) => exposed_in(listed, own, namespace, name),
                // Of a package the index cannot tell which type a constructor is of
                None => {
                    namespace != Namespace::Constructor
                        && exposed_in(listed, &Declared::default(), namespace, name)
                }
            },
        }
    }

    /// The module that a name resolves to, or `None` for a local binding and
    /// for a name the index cannot place, such as one of the default imports.
    pub(super) fn resolve_occurrence<'v>(
        &self,
        declared: &BTreeMap<String, Declared>,
        view: &'v ModuleView,
        occurrence: &Occurrence<'v>,
        bound: &[&str],
    ) -> Option<&'v str> {
        let own = &view.module.module_name;
        match occurrence.site {
            Site::OwnModule => return Some(own),
            Site::ImportOf(module) => return Some(module),
            Site::Use => {}
        }
        let imports = &view.module.imports;
        if let Some(qualifier) = occurrence.qualifier {
            // An alias replaces the module's name as its qualifier. Two
            // imports can share an alias, and then the one that exposes the
            // name is meant.
            let mut candidates = imports.iter().filter(|import| match &import.alias {
                Some(alias) => alias == qualifier,
                None => import.module_name == qualifier,
            });
            let first = candidates.clone().next()?;
            return Some(
                candidates
                    .find(|import| {
                        self.module_exposes(
                            declared,
                            &import.module_name,
                            occurrence.namespace,
                            occurrence.name,
                        )
                    })
                    .unwrap_or(first)
                    .module_name
                    .as_str(),
            );
        }
        if occurrence.namespace == Namespace::Value && bound.contains(&occurrence.name) {
            return None;
        }
        // A top-level declaration takes precedence over what imports expose
        if declared
            .get(own.as_str())
            .is_some_and(|own| own.has(occurrence.namespace, occurrence.name))
        {
            return Some(own);
        }
        imports
            .iter()
            .find(|import| {
                self.import_exposes(declared, import, occurrence.namespace, occurrence.name)
            })
            .map(|import| import.module_name.as_str())
    }

    /// Whether a type of the module is a record alias, whose constructor is
    /// the alias itself. A variant called like its type, as in
    /// `type Email = Email String`, is a name of its own that a rename of the
    /// type leaves alone.
    pub fn is_record_alias(&self, module: &str, type_name: &str) -> bool {
        let Some(uri) = self
            .modules
            .get(module)
            .and_then(|elm_module| Url::from_file_path(&elm_module.path).ok())
        else {
            return false;
        };
        let (Some(tree), Some(source)) = (
            self.type_checker.get_tree(uri.as_str()),
            self.type_checker.get_source(uri.as_str()),
        ) else {
            return false;
        };
        Declared::of(tree.root_node(), source)
            .record_aliases
            .contains(type_name)
    }

    /// The places that a rename of the target to `new_name` changes: every
    /// place that names the target, its declaration and its entries in
    /// exposing lists among them, in a fixed order. `Err` holds the reason
    /// when the rename would make a name mean something else than it does
    /// now, which names the file and line. Such a rename can compile and still
    /// be wrong, so it must not be done.
    pub fn rename_references(
        &self,
        target: &Target,
        new_name: &str,
    ) -> anyhow::Result<Result<Vec<SymbolReference>, String>> {
        let views = self.module_views()?;
        let declared = declarations(&views);
        let findings = self.resolve_target_in(&views, &declared, target, new_name);
        if let Some(reason) = self.rename_conflict(&views, &declared, &findings, target, new_name) {
            return Ok(Err(reason));
        }
        Ok(Ok(views
            .iter()
            .zip(findings)
            .flat_map(|(view, found)| {
                let uri = view.uri.clone();
                found.uses.into_iter().map(move |range| SymbolReference {
                    uri: uri.clone(),
                    range,
                    is_definition: false,
                    kind: None,
                    type_context: None,
                })
            })
            .collect()))
    }

    /// The top-level declaration of the project that the name at this place
    /// resolves to: its module, its name and its namespace. `None` for a
    /// local variable, a field, a name of a package and a place that names
    /// nothing.
    pub fn target_at(
        &self,
        uri: &Url,
        position: Position,
    ) -> anyhow::Result<Option<(String, String, Namespace)>> {
        let views = self.module_views()?;
        let declared = declarations(&views);
        let Some(view) = views.iter().find(|view| &view.uri == uri) else {
            return Ok(None);
        };
        let mut found = None;
        let mut visit = |occurrence: Occurrence, bound: &[&str]| {
            if found.is_some() || !contains(&occurrence.range, position) {
                return;
            }
            found = self
                .resolve_occurrence(&declared, view, &occurrence, bound)
                .filter(|module| {
                    declared
                        .get(*module)
                        .is_some_and(|own| own.has(occurrence.namespace, occurrence.name))
                })
                .map(|module| {
                    (
                        module.to_string(),
                        occurrence.name.to_string(),
                        occurrence.namespace,
                    )
                });
        };
        walk(
            view.tree.root_node(),
            &view.source,
            &mut Vec::new(),
            &mut visit,
        );
        Ok(found)
    }

    /// Every place that names the target, its declaration and its entries in
    /// exposing lists among them, module by module in the order of their
    /// paths. A use that the compiler resolves to something else, such as a
    /// namesake in another module, a local variable or a string, is none.
    pub fn uses_of(&self, target: &Target) -> anyhow::Result<Vec<ModuleUses>> {
        let views = self.module_views()?;
        let declared = declarations(&views);
        let findings = self.resolve_target_in(&views, &declared, target, target.name);
        Ok(views
            .into_iter()
            .zip(findings)
            .filter(|(_, found)| !found.uses.is_empty())
            .map(|(view, found)| ModuleUses {
                places: found
                    .uses
                    .iter()
                    .map(|range| (*range, is_declared_at(&view.tree, range)))
                    .collect(),
                uri: view.uri,
                module_name: view.module.module_name.clone(),
                source: view.source,
                tree: view.tree,
            })
            .collect())
    }

    /// The places that name any of the targets, as `uses_of` finds them, in
    /// the modules that name one of them at least. Each place has the index
    /// of the target that it names in `targets`.
    pub fn uses_of_each(&self, targets: &[Target]) -> anyhow::Result<Vec<ModuleUsesOfEach>> {
        let views = self.module_views()?;
        let declared = declarations(&views);
        // One walk of each module finds them all, since a type can have very many variants
        let wanted: HashMap<(Namespace, &str), usize> = targets
            .iter()
            .enumerate()
            .map(|(index, target)| ((target.namespace, target.name), index))
            .collect();
        let mut modules = Vec::new();
        for view in views {
            let mut places = Vec::new();
            let mut variants_of = BTreeMap::new();
            let mut visit = |occurrence: Occurrence, bound: &[&str]| {
                if occurrence.namespace != Namespace::Constructor {
                    return;
                }
                let module = self.resolve_occurrence(&declared, &view, &occurrence, bound);
                let variants = module
                    .and_then(|module| declared.get(module))
                    .and_then(|own| own.variants_alongside(occurrence.name));
                if let Some(variants) = variants {
                    variants_of.insert(occurrence.range.start, variants.clone());
                }
                let Some(&index) = wanted.get(&(occurrence.namespace, occurrence.name)) else {
                    return;
                };
                if module == Some(targets[index].module) {
                    places.push((index, occurrence.range));
                }
            };
            walk(
                view.tree.root_node(),
                &view.source,
                &mut Vec::new(),
                &mut visit,
            );
            if places.is_empty() {
                continue;
            }
            modules.push(ModuleUsesOfEach {
                places: places
                    .into_iter()
                    .map(|(index, range)| (index, range, is_declared_at(&view.tree, &range)))
                    .collect(),
                uri: view.uri,
                module_name: view.module.module_name.clone(),
                source: view.source,
                tree: view.tree,
                variants_of,
            });
        }
        Ok(modules)
    }

    /// Why renaming the target to `new_name` would change what a name means:
    /// a use of the target would come to mean something else, or a use of
    /// something else would come to mean the target.
    fn rename_conflict(
        &self,
        views: &[ModuleView],
        declared: &BTreeMap<String, Declared>,
        findings: &[Findings],
        target: &Target,
        new_name: &str,
    ) -> Option<String> {
        let what = match target.namespace {
            Namespace::Value => "function",
            Namespace::Type => "type",
            Namespace::Constructor => "variant",
        };
        let place = |uri: &Url, range: &Range| {
            let path = uri.to_file_path().unwrap_or_default();
            let shown = path
                .strip_prefix(&self.root_path)
                .unwrap_or(&path)
                .to_path_buf();
            format!("{}:{}", shown.display(), range.start.line + 1)
        };

        for (view, found) in views.iter().zip(findings) {
            let module = view.module;
            let own = declared.get(&module.module_name);
            let is_home = module.module_name == target.module;
            let declares_new_name = own.is_some_and(|own| own.has(target.namespace, new_name));

            if is_home && declares_new_name {
                return Some(format!(
                    "{} already declares a {} {}",
                    module.module_name, what, new_name
                ));
            }
            // Elm takes a local variable of the name of a top-level value of
            // its own module for an error, wherever it stands
            if is_home && target.namespace == Namespace::Value {
                if let Some(range) = local_binding(view.tree.root_node(), &view.source, new_name) {
                    return Some(format!(
                        "at {} a local {} would shadow the renamed {}, which Elm does not allow",
                        place(&view.uri, &range),
                        new_name,
                        what
                    ));
                }
            }
            for (range, bound) in &found.unqualified {
                if target.namespace == Namespace::Value && bound.iter().any(|name| name == new_name)
                {
                    return Some(format!(
                        "at {} a local {} would hide the renamed {}",
                        place(&view.uri, range),
                        new_name,
                        what
                    ));
                }
                if is_home {
                    continue;
                }
                if declares_new_name {
                    return Some(format!(
                        "at {} {} would name the {} that {} declares",
                        place(&view.uri, range),
                        new_name,
                        new_name,
                        module.module_name
                    ));
                }
                let other = module.imports.iter().find(|import| {
                    import.module_name != target.module
                        && self.import_exposes(declared, import, target.namespace, new_name)
                });
                if let Some(other) = other {
                    return Some(format!(
                        "at {} {} would also be the {} that the import of {} exposes",
                        place(&view.uri, range),
                        new_name,
                        new_name,
                        other.module_name
                    ));
                }
            }
            // Where the renamed target is visible unqualified, a use of the new
            // name that means something else now would mean the target then. A
            // module's own declaration of the new name keeps its uses.
            let sees_target = is_home
                || module.imports.iter().any(|import| {
                    import.module_name == target.module
                        && self.import_exposes(declared, import, target.namespace, target.name)
                });
            if sees_target && (is_home || !declares_new_name) {
                if let Some(range) = found.new_name_uses.first() {
                    return Some(format!(
                        "at {} {} names something else, which the renamed {} would take the place of",
                        place(&view.uri, range),
                        new_name,
                        what
                    ));
                }
            }
        }
        None
    }

    fn resolve_target_in(
        &self,
        views: &[ModuleView],
        declared: &BTreeMap<String, Declared>,
        target: &Target,
        new_name: &str,
    ) -> Vec<Findings> {
        views
            .iter()
            .map(|view| {
                let mut found = Findings::default();
                let mut visit = |occurrence: Occurrence, bound: &[&str]| {
                    if occurrence.namespace != target.namespace {
                        return;
                    }
                    if occurrence.name == new_name
                        && occurrence.qualifier.is_none()
                        && occurrence.site == Site::Use
                        && !(occurrence.namespace == Namespace::Value
                            && bound.contains(&occurrence.name))
                    {
                        found.new_name_uses.push(occurrence.range);
                    }
                    if occurrence.name != target.name {
                        return;
                    }
                    if self.resolve_occurrence(declared, view, &occurrence, bound)
                        != Some(target.module)
                    {
                        return;
                    }
                    if occurrence.qualifier.is_none() && occurrence.site == Site::Use {
                        found.unqualified.push((
                            occurrence.range,
                            bound.iter().map(|name| name.to_string()).collect(),
                        ));
                    }
                    found.uses.push(occurrence.range);
                };
                walk(
                    view.tree.root_node(),
                    &view.source,
                    &mut Vec::new(),
                    &mut visit,
                );
                found
            })
            .collect()
    }
}

/// Whether an explicit exposing list lets the name out of a module that
/// declares `own`. `Type(..)` lets out the type and its variants, and a record
/// alias lets out its constructor under its own name.
fn exposed_in(listed: &[String], own: &Declared, namespace: Namespace, name: &str) -> bool {
    match namespace {
        Namespace::Value => listed.iter().any(|entry| entry == name),
        Namespace::Type => listed
            .iter()
            .any(|entry| entry == name || entry.strip_suffix("(..)") == Some(name)),
        Namespace::Constructor => listed.iter().any(|entry| {
            let (type_name, all) = match entry.strip_suffix("(..)") {
                Some(type_name) => (type_name, true),
                None => (entry.as_str(), false),
            };
            own.constructors_of
                .get(type_name)
                .is_some_and(|constructors| {
                    constructors.iter().any(|constructor| constructor == name)
                        && (all || own.record_aliases.contains(type_name))
                })
        }),
    }
}
