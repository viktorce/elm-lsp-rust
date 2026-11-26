//! Which record a use of a field belongs to, found by type inference over the
//! whole project.
//!
//! Elm's records are structural. Two uses of a field `title` belong to the
//! same record when the compiler unifies the records they stand on, and a
//! rename has to change both or neither. So every field of a record type gets
//! a slot, and unification joins the slots of the fields it matches up. An
//! alias, a variant with a record and a record in an annotation give their
//! slots once, and each expansion or instance of them shares those slots.
//! A generic function such as `getTitle : { a | title : String } -> String`
//! thus joins the field of every record that is passed to it, which is what
//! renaming that field asks for.
//!
//! The types of packages come from their sources, which the compiler keeps
//! in its cache of packages, starting from the modules the project imports.
//!
//! Where the inference cannot type something, a name it cannot resolve or a
//! construct it does not know, it marks the declaration as uncertain. A use of
//! the field there that no record claims is then one it cannot place, and the
//! rename refuses rather than guess.

use std::collections::{HashMap, HashSet};
use std::path::PathBuf;
use std::rc::Rc;

use tower_lsp::lsp_types::{Position, Range, Url};
use tree_sitter::{Node, Tree};

type Name = Rc<str>;

/// A module of the project as the index holds it
pub struct SourceModule<'t> {
    pub uri: &'t str,
    pub source: &'t str,
    pub tree: &'t Tree,
}

/// One edit of a field rename
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FieldEdit {
    pub uri: String,
    pub range: Range,
}

/// The name of the field that the identifier at `node` stands for, where it
/// is one: in a record type, an access, an accessor, a record expression or a
/// record pattern.
pub fn field_name_at<'a>(node: Node, source: &'a str) -> Option<&'a str> {
    if node.kind() != "lower_case_identifier" {
        return None;
    }
    let parent = node.parent()?;
    let is_field = match parent.kind() {
        "field_type" | "field" => parent
            .child_by_field_name("name")
            .is_some_and(|name| name.id() == node.id()),
        "field_access_expr" | "field_accessor_function_expr" => true,
        "lower_pattern" => parent
            .parent()
            .is_some_and(|grand| grand.kind() == "record_pattern"),
        _ => false,
    };
    is_field.then(|| &source[node.byte_range()])
}

/// The uses of a field that removing it from its record changes
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FieldRemoval {
    /// The field in record types, accesses, accessors, record expressions and record patterns
    pub fields: Vec<FieldEdit>,
    /// The uses of the variables that the record patterns among them bind
    pub bound: Vec<FieldEdit>,
}

/// The edits that rename the field at `at` in the module `uri` to `new_name`.
/// `None` where no field stands there. An error says why the rename is not
/// possible, and nothing is to change then.
pub fn rename_field(
    modules: &[SourceModule],
    package_dirs: &[PathBuf],
    uri: &str,
    at: tree_sitter::Point,
    new_name: &str,
) -> Option<Result<Vec<FieldEdit>, String>> {
    infer_field(modules, package_dirs, uri, at, |inference, node| {
        inference.plan_rename(uri, node, new_name)
    })
}

/// The places that name the field at `at` in the module `uri` for the same
/// record, the variables that record patterns bind with them included, as a
/// rename of the field would change them. `None` where no field stands there.
/// An error says why the server cannot tell them.
pub fn field_references(
    modules: &[SourceModule],
    package_dirs: &[PathBuf],
    uri: &str,
    at: tree_sitter::Point,
) -> Option<Result<Vec<FieldEdit>, String>> {
    infer_field(modules, package_dirs, uri, at, |inference, node| {
        inference.plan_references(uri, node)
    })
}

/// The uses that removing the field at `at` in the module `uri` from its
/// record changes. `None` where no field stands there. An error says why the
/// removal is not possible, and nothing is to change then.
pub fn remove_field(
    modules: &[SourceModule],
    package_dirs: &[PathBuf],
    uri: &str,
    at: tree_sitter::Point,
) -> Option<Result<FieldRemoval, String>> {
    infer_field(modules, package_dirs, uri, at, |inference, node| {
        inference.plan_removal(uri, node)
    })
}

/// Infer the records of the project for the field at `at`, and hand the
/// inference with the id of the field's node to `plan`
fn infer_field<T: Send>(
    modules: &[SourceModule],
    package_dirs: &[PathBuf],
    uri: &str,
    at: tree_sitter::Point,
    plan: impl FnOnce(&mut Inference, usize) -> Result<T, String> + Send,
) -> Option<Result<T, String>> {
    let module = modules.iter().find(|m| m.uri == uri)?;
    let node = module.tree.root_node().descendant_for_point_range(at, at)?;
    let field = field_name_at(node, module.source)?.to_string();
    let node_id = node.id();
    // Deep expressions and types recurse deeply, so the work gets a stack of its own
    let result = std::thread::scope(|scope| {
        std::thread::Builder::new()
            .stack_size(256 * 1024 * 1024)
            .spawn_scoped(scope, || {
                let packages = PackageModules::read(package_dirs, modules);
                let mut inference = Inference::new(modules, &packages, &field);
                inference.run();
                plan(&mut inference, node_id)
            })
            .map(|handle| handle.join())
    });
    Some(match result {
        Ok(Ok(plan)) => plan,
        _ => Err(format!(
            "The server could not tell the records of the field `{field}`: the type inference failed"
        )),
    })
}

// ---------------------------------------------------------------------------
// Types

#[derive(Clone, Debug)]
enum Ty {
    Var(u32),
    Con(Rc<(Name, Name, Vec<Ty>)>),
    Fun(Rc<(Ty, Ty)>),
    Tuple(Rc<Vec<Ty>>),
    Unit,
    Record(Rc<RecordTy>),
    /// What the inference could not type. It unifies with anything and joins nothing.
    Unknown,
}

#[derive(Clone, Debug)]
struct RecordTy {
    /// Sorted by name
    fields: Vec<Field>,
    /// `None` for a closed record, else a variable or a record that holds the rest
    row: Option<Ty>,
}

#[derive(Clone, Debug)]
struct Field {
    name: Name,
    ty: Ty,
    slot: u32,
}

fn fun(param: Ty, ret: Ty) -> Ty {
    Ty::Fun(Rc::new((param, ret)))
}

fn con(module: &str, name: &str, args: Vec<Ty>) -> Ty {
    Ty::Con(Rc::new((module.into(), name.into(), args)))
}

fn record(mut fields: Vec<Field>, row: Option<Ty>) -> Ty {
    fields.sort_by(|a, b| a.name.cmp(&b.name));
    Ty::Record(Rc::new(RecordTy { fields, row }))
}

struct VarCell {
    link: Option<Ty>,
    level: u32,
    rigid: bool,
    name: Option<Name>,
}

#[derive(Clone)]
struct Scheme {
    quantified: Vec<u32>,
    ty: Ty,
    /// Built from something the inference could not fully type
    tainted: bool,
}

impl Scheme {
    fn mono(ty: Ty) -> Self {
        Scheme {
            quantified: Vec::new(),
            ty,
            tainted: false,
        }
    }
}

// ---------------------------------------------------------------------------
// Modules and what they declare

#[derive(Default)]
struct Exposed {
    values: HashSet<Name>,
    /// A type with `true` exposes its variants too
    types: HashMap<Name, bool>,
    operators: HashSet<Name>,
}

enum Exposing {
    All,
    Some(Exposed),
}

struct Import {
    module: Name,
    alias: Option<Name>,
    exposing: Exposing,
}

struct Operator {
    value: Name,
    precedence: u32,
    right: bool,
}

struct Value<'t> {
    declaration: Option<Node<'t>>,
    annotation: Option<Node<'t>>,
}

struct Module<'t> {
    name: Name,
    /// The uri of a module of the project, `None` for one of a package
    uri: Option<&'t str>,
    /// The package of a package module, by its place in the list of packages
    package: Option<usize>,
    source: &'t str,
    root: Node<'t>,
    exposing: Exposing,
    imports: Vec<Import>,
    aliases: HashMap<Name, Node<'t>>,
    unions: HashMap<Name, Node<'t>>,
    /// Each variant with the name of its type
    variants: HashMap<Name, Name>,
    values: HashMap<Name, Value<'t>>,
    operators: HashMap<Name, Operator>,
}

fn text<'s>(node: Node, source: &'s str) -> &'s str {
    &source[node.byte_range()]
}

fn is_comment(node: Node) -> bool {
    matches!(node.kind(), "line_comment" | "block_comment")
}

fn named_children(node: Node) -> Vec<Node> {
    let mut cursor = node.walk();
    node.named_children(&mut cursor)
        .filter(|child| !is_comment(*child))
        .collect()
}

fn field_children<'t>(node: Node<'t>, field: &str) -> Vec<Node<'t>> {
    let mut cursor = node.walk();
    node.children_by_field_name(field, &mut cursor)
        .filter(|child| child.is_named() && !is_comment(*child))
        .collect()
}

fn child_of_kind<'t>(node: Node<'t>, kind: &str) -> Option<Node<'t>> {
    let mut cursor = node.walk();
    let found = node.named_children(&mut cursor).find(|c| c.kind() == kind);
    found
}

fn read_exposing(list: Node, source: &str) -> Exposing {
    let mut exposed = Exposed::default();
    for child in named_children(list) {
        match child.kind() {
            "double_dot" => return Exposing::All,
            "exposed_value" => {
                exposed.values.insert(text(child, source).into());
            }
            "exposed_type" => {
                if let Some(name) = child_of_kind(child, "upper_case_identifier") {
                    let with_variants =
                        child_of_kind(child, "exposed_union_constructors").is_some();
                    exposed
                        .types
                        .insert(text(name, source).into(), with_variants);
                }
            }
            "exposed_operator" => {
                if let Some(op) = child.child_by_field_name("operator") {
                    exposed.operators.insert(text(op, source).into());
                }
            }
            _ => {}
        }
    }
    Exposing::Some(exposed)
}

/// The imports that every module of an application has without asking
fn default_imports() -> Vec<Import> {
    let some = |values: &[&str], types: &[(&str, bool)], operators: &[&str]| {
        Exposing::Some(Exposed {
            values: values.iter().map(|v| (*v).into()).collect(),
            types: types.iter().map(|(t, all)| ((*t).into(), *all)).collect(),
            operators: operators.iter().map(|o| (*o).into()).collect(),
        })
    };
    let import = |module: &str, alias: Option<&str>, exposing| Import {
        module: module.into(),
        alias: alias.map(Into::into),
        exposing,
    };
    vec![
        import("Basics", None, Exposing::All),
        import("List", None, some(&[], &[("List", false)], &["::"])),
        import("Maybe", None, some(&[], &[("Maybe", true)], &[])),
        import("Result", None, some(&[], &[("Result", true)], &[])),
        import("String", None, some(&[], &[("String", false)], &[])),
        import("Char", None, some(&[], &[("Char", false)], &[])),
        import("Tuple", None, some(&[], &[], &[])),
        import("Debug", None, some(&[], &[], &[])),
        import("Platform", None, some(&[], &[("Program", false)], &[])),
        import(
            "Platform.Cmd",
            Some("Cmd"),
            some(&[], &[("Cmd", false)], &[]),
        ),
        import(
            "Platform.Sub",
            Some("Sub"),
            some(&[], &[("Sub", false)], &[]),
        ),
    ]
}

impl<'t> Module<'t> {
    fn read(
        uri: Option<&'t str>,
        package: Option<usize>,
        source: &'t str,
        root: Node<'t>,
    ) -> Option<Self> {
        let declaration = child_of_kind(root, "module_declaration")?;
        let name = text(declaration.child_by_field_name("name")?, source);
        let exposing = declaration
            .child_by_field_name("exposing")
            .map(|list| read_exposing(list, source))
            .unwrap_or(Exposing::Some(Exposed::default()));
        let mut module = Module {
            name: name.into(),
            uri,
            package,
            source,
            root,
            exposing,
            imports: Vec::new(),
            aliases: HashMap::new(),
            unions: HashMap::new(),
            variants: HashMap::new(),
            values: HashMap::new(),
            operators: HashMap::new(),
        };
        let mut annotations: HashMap<Name, Node<'t>> = HashMap::new();
        for child in named_children(root) {
            match child.kind() {
                "import_clause" => {
                    let Some(module_name) = child.child_by_field_name("moduleName") else {
                        continue;
                    };
                    let alias = child
                        .child_by_field_name("asClause")
                        .and_then(|clause| clause.child_by_field_name("name"))
                        .map(|alias| text(alias, source).into());
                    let exposing = child
                        .child_by_field_name("exposing")
                        .map(|list| read_exposing(list, source))
                        .unwrap_or(Exposing::Some(Exposed::default()));
                    module.imports.push(Import {
                        module: text(module_name, source).into(),
                        alias,
                        exposing,
                    });
                }
                "type_alias_declaration" => {
                    if let Some(name) = child.child_by_field_name("name") {
                        module.aliases.insert(text(name, source).into(), child);
                    }
                }
                "type_declaration" => {
                    if let Some(name) = child.child_by_field_name("name") {
                        let type_name: Name = text(name, source).into();
                        for variant in field_children(child, "unionVariant") {
                            if let Some(variant_name) = variant.child_by_field_name("name") {
                                module
                                    .variants
                                    .insert(text(variant_name, source).into(), type_name.clone());
                            }
                        }
                        module.unions.insert(type_name, child);
                    }
                }
                "type_annotation" | "port_annotation" => {
                    if let (Some(name), Some(ty)) = (
                        child.child_by_field_name("name"),
                        child.child_by_field_name("typeExpression"),
                    ) {
                        annotations.insert(text(name, source).into(), ty);
                    }
                }
                "infix_declaration" => {
                    let field = |name| child.child_by_field_name(name).map(|n| text(n, source));
                    if let (Some(op), Some(value)) =
                        (field("operator"), child_of_kind(child, "value_expr"))
                    {
                        module.operators.insert(
                            op.into(),
                            Operator {
                                value: text(value, source).into(),
                                precedence: field("precedence")
                                    .and_then(|p| p.parse().ok())
                                    .unwrap_or(9),
                                right: field("associativity") == Some("right"),
                            },
                        );
                    }
                }
                "value_declaration" => {
                    if let Some(name) = declared_name(child, source) {
                        module.values.insert(
                            name,
                            Value {
                                declaration: Some(child),
                                annotation: None,
                            },
                        );
                    }
                }
                _ => {}
            }
        }
        for (name, annotation) in annotations {
            module
                .values
                .entry(name)
                .or_insert(Value {
                    declaration: None,
                    annotation: None,
                })
                .annotation = Some(annotation);
        }
        // The imports every module has come before its own, which a later import of a type of the same name overrides
        let own = std::mem::replace(&mut module.imports, default_imports());
        module.imports.extend(own);
        Some(module)
    }

    /// Whether the module declares an alias of a closed record by this name.
    /// Only such an alias is also a constructor, so the value of the name of
    /// another alias is whatever else the module sees by it.
    fn is_record_alias(&self, name: &str) -> bool {
        self.aliases
            .get(name)
            .and_then(|declaration| declaration.child_by_field_name("typeExpression"))
            .and_then(record_type_of)
            .is_some_and(|record| record.child_by_field_name("baseRecord").is_none())
    }

    fn exports_value(&self, name: &str) -> bool {
        self.values.contains_key(name)
            && match &self.exposing {
                Exposing::All => true,
                Exposing::Some(exposed) => exposed.values.contains(name),
            }
    }

    fn exports_type(&self, name: &str) -> bool {
        (self.aliases.contains_key(name) || self.unions.contains_key(name))
            && match &self.exposing {
                Exposing::All => true,
                Exposing::Some(exposed) => exposed.types.contains_key(name),
            }
    }

    fn exports_operator(&self, op: &str) -> bool {
        self.operators.contains_key(op)
            && match &self.exposing {
                Exposing::All => true,
                Exposing::Some(exposed) => exposed.operators.contains(op),
            }
    }

    fn exports_variant(&self, name: &str) -> bool {
        self.variants
            .get(name)
            .is_some_and(|ty| match &self.exposing {
                Exposing::All => true,
                Exposing::Some(exposed) => exposed.types.get(ty) == Some(&true),
            })
    }
}

/// The name that a value declaration gives, `f` in `f x = ...`
fn declared_name(declaration: Node, source: &str) -> Option<Name> {
    let left = declaration.child_by_field_name("functionDeclarationLeft")?;
    let name = child_of_kind(left, "lower_case_identifier")?;
    Some(text(name, source).into())
}

impl Import {
    fn exposes_value(&self, name: &str) -> bool {
        match &self.exposing {
            Exposing::All => true,
            Exposing::Some(exposed) => exposed.values.contains(name),
        }
    }

    fn exposes_type(&self, name: &str) -> bool {
        match &self.exposing {
            Exposing::All => true,
            Exposing::Some(exposed) => exposed.types.contains_key(name),
        }
    }

    fn exposes_variants_of(&self, ty: &str) -> bool {
        match &self.exposing {
            Exposing::All => true,
            Exposing::Some(exposed) => exposed.types.get(ty) == Some(&true),
        }
    }

    fn exposes_operator(&self, op: &str) -> bool {
        match &self.exposing {
            Exposing::All => true,
            Exposing::Some(exposed) => exposed.operators.contains(op),
        }
    }

    /// An alias takes the place of the module's name, so `import Dict as D`
    /// leaves `Dict.empty` to whatever answers to `Dict` besides it
    fn answers_to(&self, qualifier: &str) -> bool {
        match &self.alias {
            Some(alias) => &**alias == qualifier,
            None => &*self.module == qualifier,
        }
    }
}

// ---------------------------------------------------------------------------
// Packages

/// The modules of the packages that the project's imports reach, read from
/// their sources
struct PackageModules {
    modules: Vec<PackageModule>,
}

struct PackageModule {
    package: usize,
    source: String,
    tree: Tree,
}

/// The modules that every module imports without asking
const DEFAULT_MODULES: &[&str] = &[
    "Basics",
    "List",
    "Maybe",
    "Result",
    "String",
    "Char",
    "Tuple",
    "Debug",
    "Platform",
    "Platform.Cmd",
    "Platform.Sub",
];

fn imported_modules(root: Node, source: &str) -> Vec<String> {
    named_children(root)
        .into_iter()
        .filter(|c| c.kind() == "import_clause")
        .filter_map(|c| c.child_by_field_name("moduleName"))
        .map(|name| text(name, source).to_string())
        .collect()
}

impl PackageModules {
    fn read(dirs: &[PathBuf], project: &[SourceModule]) -> Self {
        let mut modules = Vec::new();
        let mut parser = tree_sitter::Parser::new();
        if parser
            .set_language(&tree_sitter_elm::LANGUAGE.into())
            .is_err()
        {
            return PackageModules { modules };
        }
        // Where each module of each package lies
        let mut paths: HashMap<String, Vec<(usize, PathBuf)>> = HashMap::new();
        for (package, dir) in dirs.iter().enumerate() {
            let src = dir.join("src");
            for entry in walkdir::WalkDir::new(&src)
                .sort_by_file_name()
                .into_iter()
                .filter_map(Result::ok)
            {
                let path = entry.path();
                if path.extension().is_some_and(|e| e == "elm") {
                    if let Ok(below) = path.with_extension("").strip_prefix(&src) {
                        let name: Vec<String> = below
                            .components()
                            .map(|c| c.as_os_str().to_string_lossy().into_owned())
                            .collect();
                        paths
                            .entry(name.join("."))
                            .or_default()
                            .push((package, path.to_path_buf()));
                    }
                }
            }
        }
        // A module of a package that imports a name looks in its own package first
        let mut wanted: Vec<(Option<usize>, String)> = DEFAULT_MODULES
            .iter()
            .map(|m| (None, m.to_string()))
            .chain(
                project
                    .iter()
                    .flat_map(|m| imported_modules(m.tree.root_node(), m.source))
                    .map(|m| (None, m)),
            )
            .collect();
        wanted.reverse();
        let mut read: HashSet<(usize, String)> = HashSet::new();
        while let Some((from, name)) = wanted.pop() {
            let Some(candidates) = paths.get(&name) else {
                continue;
            };
            let Some((package, path)) = candidates
                .iter()
                .find(|(p, _)| Some(*p) == from)
                .or_else(|| candidates.first())
            else {
                continue;
            };
            if !read.insert((*package, name)) {
                continue;
            }
            let Ok(source) = std::fs::read_to_string(path) else {
                continue;
            };
            let Some(tree) = parser.parse(&source, None) else {
                continue;
            };
            for imported in imported_modules(tree.root_node(), &source) {
                wanted.push((Some(*package), imported));
            }
            modules.push(PackageModule {
                package: *package,
                source,
                tree,
            });
        }
        PackageModules { modules }
    }
}

// ---------------------------------------------------------------------------
// The inference

/// What declares the slot of a field
#[derive(Clone, Debug, PartialEq)]
enum Owner {
    /// An alias of the project, by module and name
    Alias(Name, Name),
    /// A record in a variant of a custom type of the project
    Union(Name, Name),
    /// A record type written in an annotation
    Annotation,
    /// No declaration: an access, a record expression or a pattern
    Use,
}

struct Occurrence<'t> {
    module: usize,
    node: Node<'t>,
    owner: Owner,
    slot: u32,
    /// The declaration that the use stands in, for the uncertainty it carries
    declaration: Option<usize>,
    /// The record type, expression or pattern that holds the field
    container: Node<'t>,
    /// The uses of the variable that a record pattern binds
    bound: Vec<Node<'t>>,
}

struct Template {
    params: Vec<u32>,
    body: Ty,
    /// The fields of a record alias in the order of its constructor
    constructor: Option<Vec<Name>>,
    tainted: bool,
}

struct UnionTemplate {
    module: Name,
    name: Name,
    params: Vec<u32>,
    variants: HashMap<Name, Vec<Ty>>,
    tainted: bool,
}

enum ValueState {
    InProgress(Ty),
    Done(Rc<Scheme>),
}

#[derive(Clone)]
struct Local {
    scheme: Rc<Scheme>,
    /// The occurrence of a record pattern that binds this variable
    binder: Option<usize>,
}

/// How a type variable that an annotation names for the first time is made
#[derive(Clone, Copy, PartialEq)]
enum NewVars {
    /// One that a scheme or template quantifies
    Generic,
    /// A rigid one at the current level, which a let binding generalizes
    Rigid,
}

struct TypeVars {
    map: HashMap<Name, Ty>,
    new_vars: NewVars,
    tainted: bool,
}

const GENERIC: u32 = u32::MAX;

/// An expression or a pattern in a module, where the inference is or was
type Place<'t> = (usize, Node<'t>);

/// What a top level declaration that another one asks for puts aside
struct TopLevel<'t> {
    level: u32,
    scopes: Vec<HashMap<Name, Local>>,
    type_scopes: Vec<HashMap<Name, Ty>>,
    current: Option<Place<'t>>,
}

struct Inference<'t> {
    modules: Vec<Module<'t>>,
    /// The modules of each name. Packages can each have an internal module of the same name.
    by_name: HashMap<Name, Vec<usize>>,
    field: Name,
    vars: Vec<VarCell>,
    slots: Vec<u32>,
    level: u32,
    aliases: HashMap<(usize, Name), Option<Rc<Template>>>,
    unions: HashMap<(usize, Name), Option<Rc<UnionTemplate>>>,
    values: HashMap<(usize, Name), ValueState>,
    checked: HashSet<(usize, Name)>,
    scopes: Vec<HashMap<Name, Local>>,
    /// Type variables of the annotations around, which annotations of let bindings share
    type_scopes: Vec<HashMap<Name, Ty>>,
    /// For each declaration, the first expression or pattern that the inference could not type
    tainted: Vec<Option<Place<'t>>>,
    declaration_stack: Vec<usize>,
    /// The expression or pattern that the inference is at
    current: Option<Place<'t>>,
    occurrences: Vec<Occurrence<'t>>,
    /// Slots of the field in records that packages declare, with the record's name
    package_slots: Vec<(u32, String)>,
    /// Each join of two slots of the field asked about, with where the inference was,
    /// to tell how two records came to share it
    joins: Vec<(u32, u32, Option<Place<'t>>)>,
    /// Each call of the constructor of a record alias in the project, by the
    /// alias's module and name. Its arguments follow the fields in order.
    constructor_calls: Vec<((usize, Name), Place<'t>)>,
}

impl<'t> Inference<'t> {
    fn new(project: &[SourceModule<'t>], packages: &'t PackageModules, field: &str) -> Self {
        let mut modules = Vec::new();
        for package in &packages.modules {
            if let Some(module) = Module::read(
                None,
                Some(package.package),
                &package.source,
                package.tree.root_node(),
            ) {
                modules.push(module);
            }
        }
        for module in project {
            if let Some(module) = Module::read(
                Some(module.uri),
                None,
                module.source,
                module.tree.root_node(),
            ) {
                modules.push(module);
            }
        }
        let mut by_name: HashMap<Name, Vec<usize>> = HashMap::new();
        for (index, module) in modules.iter().enumerate() {
            by_name.entry(module.name.clone()).or_default().push(index);
        }
        Inference {
            modules,
            by_name,
            field: field.into(),
            vars: Vec::new(),
            slots: Vec::new(),
            level: 0,
            aliases: HashMap::new(),
            unions: HashMap::new(),
            values: HashMap::new(),
            checked: HashSet::new(),
            scopes: Vec::new(),
            type_scopes: Vec::new(),
            tainted: Vec::new(),
            declaration_stack: Vec::new(),
            current: None,
            occurrences: Vec::new(),
            package_slots: Vec::new(),
            joins: Vec::new(),
            constructor_calls: Vec::new(),
        }
    }

    /// Infer every declaration of the project, in the order of the modules' names
    fn run(&mut self) {
        let mut project: Vec<usize> = (0..self.modules.len())
            .filter(|m| self.modules[*m].uri.is_some())
            .collect();
        project.sort_by(|a, b| self.modules[*a].name.cmp(&self.modules[*b].name));
        for m in project {
            let root = self.modules[m].root;
            let source = self.modules[m].source;
            for child in named_children(root) {
                let name = child.child_by_field_name("name").map(|n| text(n, source));
                match (child.kind(), name) {
                    ("type_alias_declaration", Some(name)) => {
                        self.alias_template(m, name);
                    }
                    ("type_declaration", Some(name)) => {
                        self.union_template(m, name);
                    }
                    ("type_annotation" | "port_annotation", Some(name)) => {
                        self.value_scheme(m, name);
                    }
                    ("value_declaration", _) => {
                        if let Some(name) = declared_name(child, source) {
                            self.check_value(m, &name);
                        }
                    }
                    _ => {}
                }
            }
        }
    }

    // --- variables and slots

    fn fresh(&mut self) -> Ty {
        self.vars.push(VarCell {
            link: None,
            level: self.level,
            rigid: false,
            name: None,
        });
        Ty::Var(self.vars.len() as u32 - 1)
    }

    fn new_var(&mut self, level: u32, rigid: bool, name: Option<Name>) -> u32 {
        self.vars.push(VarCell {
            link: None,
            level,
            rigid,
            name,
        });
        self.vars.len() as u32 - 1
    }

    fn new_slot(&mut self) -> u32 {
        self.slots.push(self.slots.len() as u32);
        self.slots.len() as u32 - 1
    }

    fn find(&mut self, slot: u32) -> u32 {
        let mut slot = slot;
        while self.slots[slot as usize] != slot {
            let parent = self.slots[slot as usize];
            self.slots[slot as usize] = self.slots[parent as usize];
            slot = parent;
        }
        slot
    }

    fn join(&mut self, a: u32, b: u32) {
        let (a, b) = (self.find(a), self.find(b));
        if a != b {
            // The lower one stays the root, so the result does not depend on the order of the joins
            let (low, high) = if a < b { (a, b) } else { (b, a) };
            self.slots[high as usize] = low;
        }
    }

    fn prune(&mut self, ty: &Ty) -> Ty {
        if let Ty::Var(v) = ty {
            if let Some(link) = self.vars[*v as usize].link.clone() {
                let pruned = self.prune(&link);
                self.vars[*v as usize].link = Some(pruned.clone());
                return pruned;
            }
        }
        ty.clone()
    }

    fn taint(&mut self) {
        if let (Some(&declaration), Some(current)) = (self.declaration_stack.last(), self.current) {
            self.tainted[declaration].get_or_insert(current);
        }
    }

    // --- unification

    fn unify_or_taint(&mut self, a: &Ty, b: &Ty) {
        if !self.unify(a, b) {
            if tracing::enabled!(tracing::Level::DEBUG) {
                let place = self
                    .current
                    .map(|(m, node)| self.place_of(m, node))
                    .unwrap_or_default();
                let (a, b) = (self.show(a), self.show(b));
                tracing::debug!("field inference: at {place}, {a} does not unify with {b}");
            }
            self.taint();
        }
    }

    /// A type as Elm writes it, for the log
    fn show(&mut self, ty: &Ty) -> String {
        match self.prune(ty) {
            Ty::Var(v) => {
                let cell = &self.vars[v as usize];
                let name = cell.name.as_deref().unwrap_or("t");
                format!("{}{}{}", if cell.rigid { "'" } else { "" }, name, v)
            }
            Ty::Con(c) => {
                let args: Vec<String> = c.2.iter().map(|t| self.show(t)).collect();
                if args.is_empty() {
                    format!("{}.{}", c.0, c.1)
                } else {
                    format!("({}.{} {})", c.0, c.1, args.join(" "))
                }
            }
            Ty::Fun(f) => format!("({} -> {})", self.show(&f.0), self.show(&f.1)),
            Ty::Tuple(t) => {
                let parts: Vec<String> = t.iter().map(|t| self.show(t)).collect();
                format!("( {} )", parts.join(", "))
            }
            Ty::Unit => "()".to_string(),
            Ty::Record(r) => {
                let fields: Vec<String> = r
                    .fields
                    .iter()
                    .map(|f| format!("{} : {}", f.name, self.show(&f.ty)))
                    .collect();
                let row = r
                    .row
                    .as_ref()
                    .map(|row| format!("{} | ", self.show(row)))
                    .unwrap_or_default();
                format!("{{ {}{} }}", row, fields.join(", "))
            }
            Ty::Unknown => "?".to_string(),
        }
    }

    fn unify(&mut self, a: &Ty, b: &Ty) -> bool {
        let a = self.prune(a);
        let b = self.prune(b);
        match (&a, &b) {
            (Ty::Unknown, _) | (_, Ty::Unknown) => true,
            (Ty::Var(x), Ty::Var(y)) if x == y => true,
            (Ty::Var(x), _) if !self.vars[*x as usize].rigid => self.bind(*x, &b),
            (_, Ty::Var(y)) if !self.vars[*y as usize].rigid => self.bind(*y, &a),
            (Ty::Con(x), Ty::Con(y)) => {
                if x.0 != y.0 || x.1 != y.1 || x.2.len() != y.2.len() {
                    return false;
                }
                let mut ok = true;
                for (p, q) in x.2.iter().zip(y.2.iter()) {
                    ok &= self.unify(p, q);
                }
                ok
            }
            (Ty::Fun(x), Ty::Fun(y)) => {
                let params = self.unify(&x.0, &y.0);
                self.unify(&x.1, &y.1) && params
            }
            (Ty::Tuple(x), Ty::Tuple(y)) => {
                if x.len() != y.len() {
                    return false;
                }
                let mut ok = true;
                for (p, q) in x.iter().zip(y.iter()) {
                    ok &= self.unify(p, q);
                }
                ok
            }
            (Ty::Unit, Ty::Unit) => true,
            (Ty::Record(x), Ty::Record(y)) => self.unify_records(x, y),
            _ => false,
        }
    }

    /// Bind `var` to `ty`, unless `ty` holds it, and lower the levels in `ty` to its level
    fn bind(&mut self, var: u32, ty: &Ty) -> bool {
        let level = self.vars[var as usize].level;
        if self.occurs(var, ty, level) {
            return false;
        }
        self.vars[var as usize].link = Some(ty.clone());
        true
    }

    fn occurs(&mut self, var: u32, ty: &Ty, level: u32) -> bool {
        match self.prune(ty) {
            Ty::Var(v) => {
                if v == var {
                    return true;
                }
                let cell = &mut self.vars[v as usize];
                cell.level = cell.level.min(level);
                false
            }
            Ty::Con(c) => c.2.iter().any(|t| self.occurs(var, t, level)),
            Ty::Fun(f) => self.occurs(var, &f.0, level) || self.occurs(var, &f.1, level),
            Ty::Tuple(t) => t.iter().any(|t| self.occurs(var, t, level)),
            Ty::Record(r) => {
                r.fields.iter().any(|f| self.occurs(var, &f.ty, level))
                    || r.row
                        .as_ref()
                        .is_some_and(|row| self.occurs(var, row, level))
            }
            Ty::Unit | Ty::Unknown => false,
        }
    }

    /// The fields of a record with those of its row, and what is left of the row:
    /// `Some(var)` for an open record, `None` for a closed one
    fn flatten(&mut self, record: &RecordTy) -> (Vec<Field>, Result<Option<u32>, ()>) {
        let mut fields = record.fields.clone();
        let mut row = record.row.clone();
        loop {
            match row.map(|r| self.prune(&r)) {
                None => break,
                Some(Ty::Var(v)) => {
                    fields.sort_by(|a, b| a.name.cmp(&b.name));
                    return (fields, Ok(Some(v)));
                }
                Some(Ty::Record(inner)) => {
                    // In `{ base | name : T }` the field of the extension wins over one of the base
                    for field in &inner.fields {
                        if !fields.iter().any(|f| f.name == field.name) {
                            fields.push(field.clone());
                        }
                    }
                    row = inner.row.clone();
                }
                Some(_) => {
                    fields.sort_by(|a, b| a.name.cmp(&b.name));
                    return (fields, Err(()));
                }
            }
        }
        fields.sort_by(|a, b| a.name.cmp(&b.name));
        (fields, Ok(None))
    }

    fn unify_records(&mut self, a: &RecordTy, b: &RecordTy) -> bool {
        let (fields_a, tail_a) = self.flatten(a);
        let (fields_b, tail_b) = self.flatten(b);
        let mut ok = true;
        let mut only_a = Vec::new();
        let mut only_b = Vec::new();
        let (mut i, mut j) = (0, 0);
        while i < fields_a.len() || j < fields_b.len() {
            let order = match (fields_a.get(i), fields_b.get(j)) {
                (Some(x), Some(y)) => x.name.cmp(&y.name),
                (Some(_), None) => std::cmp::Ordering::Less,
                _ => std::cmp::Ordering::Greater,
            };
            match order {
                std::cmp::Ordering::Equal => {
                    let (x, y) = (&fields_a[i], &fields_b[j]);
                    if x.name == self.field && self.find(x.slot) != self.find(y.slot) {
                        self.joins.push((x.slot, y.slot, self.current));
                    }
                    self.join(x.slot, y.slot);
                    ok &= self.unify(&x.ty, &y.ty);
                    i += 1;
                    j += 1;
                }
                std::cmp::Ordering::Less => {
                    only_a.push(fields_a[i].clone());
                    i += 1;
                }
                std::cmp::Ordering::Greater => {
                    only_b.push(fields_b[j].clone());
                    j += 1;
                }
            }
        }
        let (tail_a, tail_b) = match (tail_a, tail_b) {
            (Ok(a), Ok(b)) => (a, b),
            // A row that the inference lost takes what it is given
            _ => return ok,
        };
        let flexible = |this: &Self, v: u32| !this.vars[v as usize].rigid;
        ok && match (tail_a, tail_b) {
            (None, None) => only_a.is_empty() && only_b.is_empty(),
            (Some(x), None) => {
                only_a.is_empty() && flexible(self, x) && self.bind(x, &record(only_b, None))
            }
            (None, Some(y)) => {
                only_b.is_empty() && flexible(self, y) && self.bind(y, &record(only_a, None))
            }
            (Some(x), Some(y)) if x == y => only_a.is_empty() && only_b.is_empty(),
            (Some(x), Some(y)) => match (only_a.is_empty(), only_b.is_empty()) {
                (true, true) => self.unify(&Ty::Var(x), &Ty::Var(y)),
                (false, true) => {
                    flexible(self, y) && self.bind(y, &record(only_a, Some(Ty::Var(x))))
                }
                (true, false) => {
                    flexible(self, x) && self.bind(x, &record(only_b, Some(Ty::Var(y))))
                }
                (false, false) => {
                    if !flexible(self, x) || !flexible(self, y) {
                        return false;
                    }
                    let level = self.vars[x as usize].level.min(self.vars[y as usize].level);
                    let rest = Ty::Var(self.new_var(level, false, None));
                    self.bind(x, &record(only_b, Some(rest.clone())))
                        && self.bind(y, &record(only_a, Some(rest)))
                }
            },
        }
    }

    // --- schemes

    /// Copy `ty`, putting the types of `map` for its variables. Slots stay as they are.
    fn substitute(&mut self, ty: &Ty, map: &HashMap<u32, Ty>) -> Ty {
        match self.prune(ty) {
            Ty::Var(v) => map.get(&v).cloned().unwrap_or(Ty::Var(v)),
            Ty::Con(c) => {
                let args = c.2.iter().map(|t| self.substitute(t, map)).collect();
                Ty::Con(Rc::new((c.0.clone(), c.1.clone(), args)))
            }
            Ty::Fun(f) => {
                let param = self.substitute(&f.0, map);
                let ret = self.substitute(&f.1, map);
                fun(param, ret)
            }
            Ty::Tuple(t) => Ty::Tuple(Rc::new(t.iter().map(|t| self.substitute(t, map)).collect())),
            Ty::Record(r) => {
                let fields = r
                    .fields
                    .iter()
                    .map(|f| Field {
                        name: f.name.clone(),
                        ty: self.substitute(&f.ty, map),
                        slot: f.slot,
                    })
                    .collect();
                let row = r.row.as_ref().map(|row| self.substitute(row, map));
                Ty::Record(Rc::new(RecordTy { fields, row }))
            }
            other => other,
        }
    }

    fn instantiate(&mut self, scheme: &Scheme) -> Ty {
        if scheme.tainted {
            self.taint();
        }
        if scheme.quantified.is_empty() {
            return scheme.ty.clone();
        }
        let map = scheme
            .quantified
            .iter()
            .map(|v| (*v, self.fresh()))
            .collect();
        self.substitute(&scheme.ty, &map)
    }

    /// An instance whose variables are rigid, as the body of an annotated
    /// declaration sees them, with the variables by name
    fn instantiate_rigid(&mut self, scheme: &Scheme) -> (Ty, HashMap<Name, Ty>) {
        let mut map = HashMap::new();
        let mut names = HashMap::new();
        for v in &scheme.quantified {
            let name = self.vars[*v as usize].name.clone();
            let var = Ty::Var(self.new_var(self.level, true, name.clone()));
            if let Some(name) = name {
                names.insert(name, var.clone());
            }
            map.insert(*v, var);
        }
        (self.substitute(&scheme.ty, &map), names)
    }

    fn generalize(&mut self, ty: &Ty, tainted: bool) -> Scheme {
        let mut quantified = Vec::new();
        self.free_vars(ty, &mut quantified);
        let level = self.level;
        quantified.retain(|v| self.vars[*v as usize].level > level);
        Scheme {
            quantified,
            ty: ty.clone(),
            tainted,
        }
    }

    fn free_vars(&mut self, ty: &Ty, vars: &mut Vec<u32>) {
        match self.prune(ty) {
            Ty::Var(v) => {
                if !vars.contains(&v) {
                    vars.push(v);
                }
            }
            Ty::Con(c) => c.2.iter().for_each(|t| self.free_vars(t, vars)),
            Ty::Fun(f) => {
                self.free_vars(&f.0, vars);
                self.free_vars(&f.1, vars);
            }
            Ty::Tuple(t) => t.iter().for_each(|t| self.free_vars(t, vars)),
            Ty::Record(r) => {
                r.fields.iter().for_each(|f| self.free_vars(&f.ty, vars));
                if let Some(row) = &r.row {
                    self.free_vars(row, vars);
                }
            }
            Ty::Unit | Ty::Unknown => {}
        }
    }

    // --- names

    fn is_project(&self, m: usize) -> bool {
        self.modules[m].uri.is_some()
    }

    /// The first module that `visible` accepts among the one that `m` is and
    /// those that it imports, given the import, `None` for `m` itself. With a
    /// qualifier, only imports that answer to it count, and they need not expose the name.
    fn resolve(
        &self,
        m: usize,
        qualifier: Option<&str>,
        last_import_wins: bool,
        visible: impl Fn(&Module, Option<&Import>) -> bool,
    ) -> Option<usize> {
        let module = &self.modules[m];
        if qualifier.is_none() && visible(module, None) {
            return Some(m);
        }
        let mut imports: Vec<&Import> = module.imports.iter().collect();
        if last_import_wins {
            imports.reverse();
        }
        imports.into_iter().find_map(|import| {
            if qualifier.is_some_and(|q| !import.answers_to(q)) {
                return None;
            }
            let target = self.module_named(m, &import.module)?;
            visible(&self.modules[target], Some(import)).then_some(target)
        })
    }

    /// The module of this name that `m` imports: one of its own package first,
    /// then one of the project, then one of any package
    fn module_named(&self, m: usize, name: &str) -> Option<usize> {
        let found = self.by_name.get(name)?;
        let package = self.modules[m].package;
        found
            .iter()
            .find(|t| package.is_some() && self.modules[**t].package == package)
            .or_else(|| found.iter().find(|t| self.modules[**t].package.is_none()))
            .or_else(|| found.first())
            .copied()
    }

    fn resolve_value(&self, m: usize, qualifier: Option<&str>, name: &str) -> Option<usize> {
        self.resolve(m, qualifier, false, |module, import| match import {
            None => module.values.contains_key(name),
            Some(import) => {
                (qualifier.is_some() || import.exposes_value(name)) && module.exports_value(name)
            }
        })
    }

    /// Two imports can expose types of one name, and the compiler then takes the later one
    fn resolve_type(&self, m: usize, qualifier: Option<&str>, name: &str) -> Option<usize> {
        self.resolve(m, qualifier, true, |module, import| match import {
            None => module.aliases.contains_key(name) || module.unions.contains_key(name),
            Some(import) => {
                (qualifier.is_some() || import.exposes_type(name)) && module.exports_type(name)
            }
        })
    }

    /// The module of a variant, or of a record alias whose name is used as its constructor
    fn resolve_constructor(&self, m: usize, qualifier: Option<&str>, name: &str) -> Option<usize> {
        self.resolve(m, qualifier, false, |module, import| match import {
            None => module.variants.contains_key(name) || module.is_record_alias(name),
            Some(import) => {
                let variant = module.variants.get(name).is_some_and(|ty| {
                    (qualifier.is_some() || import.exposes_variants_of(ty))
                        && module.exports_variant(name)
                });
                let alias = module.is_record_alias(name)
                    && (qualifier.is_some() || import.exposes_type(name))
                    && module.exports_type(name);
                variant || alias
            }
        })
    }

    fn resolve_operator(&self, m: usize, op: &str) -> Option<(usize, Name, u32, bool)> {
        let target = self.resolve(m, None, false, |module, import| match import {
            None => module.operators.contains_key(op),
            Some(import) => import.exposes_operator(op) && module.exports_operator(op),
        })?;
        let operator = self.modules[target].operators.get(op)?;
        Some((
            target,
            operator.value.clone(),
            operator.precedence,
            operator.right,
        ))
    }

    // --- types from annotations

    fn convert(&mut self, m: usize, node: Node<'t>, vars: &mut TypeVars, owner: &Owner) -> Ty {
        let source = self.modules[m].source;
        match node.kind() {
            "type_expression" => {
                let parts: Vec<Node> = named_children(node)
                    .into_iter()
                    .filter(|c| is_type_node(*c))
                    .collect();
                let mut types: Vec<Ty> = parts
                    .iter()
                    .map(|p| self.convert(m, *p, vars, owner))
                    .collect();
                let Some(mut ty) = types.pop() else {
                    vars.tainted = true;
                    return Ty::Unknown;
                };
                while let Some(param) = types.pop() {
                    ty = fun(param, ty);
                }
                ty
            }
            "type_ref" => {
                let Some(name_node) = child_of_kind(node, "upper_case_qid") else {
                    vars.tainted = true;
                    return Ty::Unknown;
                };
                let args: Vec<Ty> = named_children(node)
                    .into_iter()
                    .filter(|c| is_type_node(*c))
                    .map(|c| self.convert(m, c, vars, owner))
                    .collect();
                let full = text(name_node, source);
                let (qualifier, name) = split_qualified(full);
                match self.type_named(m, qualifier, name, args) {
                    Some((ty, tainted)) => {
                        vars.tainted |= tainted;
                        ty
                    }
                    None => {
                        tracing::debug!(
                            "field inference: at {}, no type `{full}`",
                            self.place_of(m, node)
                        );
                        vars.tainted = true;
                        Ty::Unknown
                    }
                }
            }
            "type_variable" => self.type_variable(text(node, source), vars),
            "record_type" => {
                let row = node
                    .child_by_field_name("baseRecord")
                    .map(|base| self.type_variable(text(base, source), vars));
                let mut fields = Vec::new();
                for field_type in field_children(node, "fieldType") {
                    let (Some(name), Some(ty)) = (
                        field_type.child_by_field_name("name"),
                        field_type.child_by_field_name("typeExpression"),
                    ) else {
                        continue;
                    };
                    let slot = self.new_slot();
                    let field_name = text(name, source);
                    if field_name == &*self.field {
                        self.declare(m, name, node, owner, slot);
                    }
                    let ty = self.convert(m, ty, vars, owner);
                    fields.push(Field {
                        name: field_name.into(),
                        ty,
                        slot,
                    });
                }
                record(fields, row)
            }
            "tuple_type" => {
                if node.child_by_field_name("unitExpr").is_some() {
                    return Ty::Unit;
                }
                let types = field_children(node, "typeExpression")
                    .into_iter()
                    .map(|t| self.convert(m, t, vars, owner))
                    .collect();
                Ty::Tuple(Rc::new(types))
            }
            "unit_expr" => Ty::Unit,
            _ => {
                vars.tainted = true;
                Ty::Unknown
            }
        }
    }

    fn type_variable(&mut self, name: &str, vars: &mut TypeVars) -> Ty {
        if let Some(ty) = vars.map.get(name) {
            return ty.clone();
        }
        if vars.new_vars == NewVars::Rigid {
            for scope in self.type_scopes.iter().rev() {
                if let Some(ty) = scope.get(name) {
                    return ty.clone();
                }
            }
        }
        let (level, rigid) = match vars.new_vars {
            NewVars::Generic => (GENERIC, false),
            NewVars::Rigid => (self.level, true),
        };
        let var = Ty::Var(self.new_var(level, rigid, Some(name.into())));
        vars.map.insert(name.into(), var.clone());
        var
    }

    /// Note a field of the name asked about in a record type that `owner` declares
    fn declare(&mut self, m: usize, name: Node<'t>, container: Node<'t>, owner: &Owner, slot: u32) {
        if self.is_project(m) {
            self.occurrences.push(Occurrence {
                module: m,
                node: name,
                owner: owner.clone(),
                slot,
                declaration: None,
                container,
                bound: Vec::new(),
            });
        } else {
            let place = match owner {
                Owner::Alias(module, alias) | Owner::Union(module, alias) => {
                    format!("{module}.{alias}")
                }
                _ => format!("a type of {}", self.modules[m].name),
            };
            self.package_slots.push((slot, place));
        }
    }

    /// The type that a name in an annotation stands for, applied to `args`
    fn type_named(
        &mut self,
        m: usize,
        qualifier: Option<&str>,
        name: &str,
        args: Vec<Ty>,
    ) -> Option<(Ty, bool)> {
        let Some(target) = self.resolve_type(m, qualifier, name) else {
            // The compiler declares `List` itself
            return (name == "List" && matches!(qualifier, None | Some("List")) && args.len() == 1)
                .then(|| (con("List", "List", args), false));
        };
        if self.modules[target].aliases.contains_key(name) {
            let template = self.alias_template(target, name)?;
            if template.params.len() != args.len() {
                return None;
            }
            let map = template.params.iter().copied().zip(args).collect();
            let body = template.body.clone();
            return Some((self.substitute(&body, &map), template.tainted));
        }
        let module = self.modules[target].name.clone();
        Some((Ty::Con(Rc::new((module, name.into(), args))), false))
    }

    fn alias_template(&mut self, m: usize, name: &str) -> Option<Rc<Template>> {
        let key = (m, Name::from(name));
        if let Some(found) = self.aliases.get(&key) {
            return found.clone();
        }
        self.aliases.insert(key.clone(), None);
        let declaration = *self.modules[m].aliases.get(name)?;
        let source = self.modules[m].source;
        let mut vars = TypeVars {
            map: HashMap::new(),
            new_vars: NewVars::Generic,
            tainted: false,
        };
        let mut params = Vec::new();
        for param in field_children(declaration, "typeVariable") {
            if let Ty::Var(v) = self.type_variable(text(param, source), &mut vars) {
                params.push(v);
            }
        }
        let owner = Owner::Alias(self.modules[m].name.clone(), name.into());
        let body_node = declaration.child_by_field_name("typeExpression")?;
        let body = self.convert(m, body_node, &mut vars, &owner);
        // A record alias is also a function that takes its fields in the order they are written
        let constructor = record_type_of(body_node).and_then(|record_node| {
            if record_node.child_by_field_name("baseRecord").is_some() {
                return None;
            }
            Some(
                field_children(record_node, "fieldType")
                    .into_iter()
                    .filter_map(|f| f.child_by_field_name("name"))
                    .map(|n| Name::from(text(n, source)))
                    .collect(),
            )
        });
        let template = Rc::new(Template {
            params,
            body,
            constructor,
            tainted: vars.tainted,
        });
        self.aliases.insert(key, Some(template.clone()));
        Some(template)
    }

    fn union_template(&mut self, m: usize, name: &str) -> Option<Rc<UnionTemplate>> {
        let key = (m, Name::from(name));
        if let Some(found) = self.unions.get(&key) {
            return found.clone();
        }
        self.unions.insert(key.clone(), None);
        let declaration = *self.modules[m].unions.get(name)?;
        let source = self.modules[m].source;
        let mut vars = TypeVars {
            map: HashMap::new(),
            new_vars: NewVars::Generic,
            tainted: false,
        };
        let mut params = Vec::new();
        for param in field_children(declaration, "typeName") {
            if let Ty::Var(v) = self.type_variable(text(param, source), &mut vars) {
                params.push(v);
            }
        }
        let owner = Owner::Union(self.modules[m].name.clone(), name.into());
        let mut variants = HashMap::new();
        for variant in field_children(declaration, "unionVariant") {
            let Some(variant_name) = variant.child_by_field_name("name") else {
                continue;
            };
            let args = named_children(variant)
                .into_iter()
                .filter(|c| is_type_node(*c))
                .map(|c| self.convert(m, c, &mut vars, &owner))
                .collect();
            variants.insert(Name::from(text(variant_name, source)), args);
        }
        let template = Rc::new(UnionTemplate {
            module: self.modules[m].name.clone(),
            name: name.into(),
            params,
            variants,
            tainted: vars.tainted,
        });
        self.unions.insert(key, Some(template.clone()));
        Some(template)
    }

    /// The type of a variant, or of a record alias's constructor
    fn constructor_scheme(&mut self, m: usize, name: &str) -> Option<Scheme> {
        if let Some(type_name) = self.modules[m].variants.get(name).cloned() {
            let template = self.union_template(m, &type_name)?;
            let args = template.variants.get(name)?.clone();
            let result = Ty::Con(Rc::new((
                template.module.clone(),
                template.name.clone(),
                template.params.iter().map(|v| Ty::Var(*v)).collect(),
            )));
            let ty = args
                .into_iter()
                .rev()
                .fold(result, |ret, arg| fun(arg, ret));
            return Some(Scheme {
                quantified: template.params.clone(),
                ty,
                tainted: template.tainted,
            });
        }
        let template = self.alias_template(m, name)?;
        let order = template.constructor.clone()?;
        let body = self.prune(&template.body);
        let Ty::Record(fields) = &body else {
            return None;
        };
        let mut ty = body.clone();
        for field_name in order.iter().rev() {
            let field = fields.fields.iter().find(|f| &f.name == field_name)?;
            ty = fun(field.ty.clone(), ty);
        }
        Some(Scheme {
            quantified: template.params.clone(),
            ty,
            tainted: template.tainted,
        })
    }

    /// The scheme of a top level value, inferring it first where it has no annotation
    fn value_scheme(&mut self, m: usize, name: &str) -> Option<Rc<Scheme>> {
        let key = (m, Name::from(name));
        match self.values.get(&key) {
            Some(ValueState::Done(scheme)) => return Some(scheme.clone()),
            Some(ValueState::InProgress(ty)) => return Some(Rc::new(Scheme::mono(ty.clone()))),
            None => {}
        }
        let value = self.modules[m].values.get(name)?;
        let (annotation, declaration) = (value.annotation, value.declaration);
        if let Some(annotation) = annotation {
            let mut vars = TypeVars {
                map: HashMap::new(),
                new_vars: NewVars::Generic,
                tainted: false,
            };
            let ty = self.convert(m, annotation, &mut vars, &Owner::Annotation);
            let quantified = vars
                .map
                .values()
                .filter_map(|t| if let Ty::Var(v) = t { Some(*v) } else { None })
                .collect();
            let scheme = Rc::new(Scheme {
                quantified,
                ty,
                tainted: vars.tainted,
            });
            self.values.insert(key, ValueState::Done(scheme.clone()));
            return Some(scheme);
        }
        let declaration = declaration?;
        self.checked.insert(key.clone());
        let saved = self.enter_top_level();
        self.current = Some((m, declaration));
        let placeholder = self.fresh();
        self.values
            .insert(key.clone(), ValueState::InProgress(placeholder.clone()));
        let index = self.begin_declaration();
        let ty = self.infer_function(m, declaration);
        self.unify_or_taint(&placeholder, &ty);
        let tainted = self.tainted[index].is_some();
        self.declaration_stack.pop();
        self.level = 0;
        let scheme = Rc::new(self.generalize(&ty, tainted));
        self.leave_top_level(saved);
        self.values.insert(key, ValueState::Done(scheme.clone()));
        Some(scheme)
    }

    /// Infer the body of a top level value against its annotation, once
    fn check_value(&mut self, m: usize, name: &str) {
        let key = (m, Name::from(name));
        if self.checked.contains(&key) {
            return;
        }
        let Some(value) = self.modules[m].values.get(name) else {
            return;
        };
        let (annotated, declaration) = (value.annotation.is_some(), value.declaration);
        if !annotated {
            self.value_scheme(m, name);
            return;
        }
        let Some(declaration) = declaration else {
            return;
        };
        self.checked.insert(key);
        let Some(scheme) = self.value_scheme(m, name) else {
            return;
        };
        let saved = self.enter_top_level();
        self.current = Some((m, declaration));
        let index = self.begin_declaration();
        if scheme.tainted {
            self.tainted[index] = Some((m, declaration));
        }
        let (expected, names) = self.instantiate_rigid(&scheme);
        self.type_scopes.push(names);
        let ty = self.infer_function(m, declaration);
        self.unify_or_taint(&ty, &expected);
        self.declaration_stack.pop();
        self.leave_top_level(saved);
    }

    fn begin_declaration(&mut self) -> usize {
        self.tainted.push(None);
        let index = self.tainted.len() - 1;
        self.declaration_stack.push(index);
        index
    }

    /// A top level declaration sees none of the locals of the one that asked for it
    fn enter_top_level(&mut self) -> TopLevel<'t> {
        let saved = TopLevel {
            level: self.level,
            scopes: std::mem::take(&mut self.scopes),
            type_scopes: std::mem::take(&mut self.type_scopes),
            current: self.current.take(),
        };
        self.level = 1;
        saved
    }

    fn leave_top_level(&mut self, saved: TopLevel<'t>) {
        self.level = saved.level;
        self.scopes = saved.scopes;
        self.type_scopes = saved.type_scopes;
        self.current = saved.current;
    }

    // --- expressions

    /// The type of a function declaration `f x y = body`, or of a value
    fn infer_function(&mut self, m: usize, declaration: Node<'t>) -> Ty {
        let Some(body) = declaration.child_by_field_name("body") else {
            self.taint();
            return Ty::Unknown;
        };
        self.scopes.push(HashMap::new());
        let mut params = Vec::new();
        if let Some(left) = declaration.child_by_field_name("functionDeclarationLeft") {
            for pattern in field_children(left, "pattern") {
                let ty = self.fresh();
                self.bind_pattern(m, pattern, &ty);
                params.push(ty);
            }
        }
        let mut ty = self.infer(m, body);
        self.scopes.pop();
        while let Some(param) = params.pop() {
            ty = fun(param, ty);
        }
        ty
    }

    fn lookup_local(&self, name: &str) -> Option<Local> {
        self.scopes
            .iter()
            .rev()
            .find_map(|scope| scope.get(name).cloned())
    }

    /// The type of the value `full`, which may be qualified, noting the use of a variable that a record pattern binds
    fn value_type(&mut self, m: usize, full: &str, use_node: Node<'t>) -> Ty {
        let (qualifier, name) = split_qualified(full);
        if qualifier.is_none() {
            if let Some(local) = self.lookup_local(name) {
                if let Some(binder) = local.binder {
                    self.occurrences[binder].bound.push(use_node);
                }
                return self.instantiate(&local.scheme);
            }
        }
        let is_constructor = name.starts_with(|c: char| c.is_uppercase());
        let scheme = if is_constructor {
            let target = self.resolve_constructor(m, qualifier, name);
            if let Some(target) = target {
                if !self.modules[target].variants.contains_key(name) && self.is_project(m) {
                    self.constructor_calls
                        .push(((target, Name::from(name)), (m, use_node)));
                }
            }
            target
                .and_then(|target| self.constructor_scheme(target, name))
                .map(Rc::new)
        } else {
            self.resolve_value(m, qualifier, name)
                .and_then(|target| self.value_scheme(target, name))
        };
        match scheme {
            Some(scheme) => self.instantiate(&scheme),
            None => {
                tracing::debug!(
                    "field inference: at {}, no value `{full}`",
                    self.place_of(m, use_node)
                );
                self.taint();
                Ty::Unknown
            }
        }
    }

    fn infer(&mut self, m: usize, node: Node<'t>) -> Ty {
        let outer = self.current.replace((m, node));
        let ty = self.infer_here(m, node);
        self.current = outer;
        ty
    }

    fn infer_here(&mut self, m: usize, node: Node<'t>) -> Ty {
        let source = self.modules[m].source;
        match node.kind() {
            "value_expr" => {
                let Some(name) = node.child_by_field_name("name") else {
                    self.taint();
                    return Ty::Unknown;
                };
                self.value_type(m, text(name, source), name)
            }
            "function_call_expr" => {
                let Some(target) = node.child_by_field_name("target") else {
                    self.taint();
                    return Ty::Unknown;
                };
                let mut ty = self.infer(m, target);
                for arg in field_children(node, "arg") {
                    let arg_ty = self.infer(m, arg);
                    ty = self.apply(&ty, &arg_ty);
                }
                ty
            }
            "bin_op_expr" => self.infer_operators(m, node),
            "field_access_expr" => {
                let (Some(target), Some(field)) = (
                    node.child_by_field_name("target"),
                    last_child_of_kind(node, "lower_case_identifier"),
                ) else {
                    self.taint();
                    return Ty::Unknown;
                };
                let target_ty = self.infer(m, target);
                let field_ty = self.fresh();
                let slot = self.use_field(m, field, node);
                let row = self.fresh();
                let wanted = record(
                    vec![Field {
                        name: text(field, source).into(),
                        ty: field_ty.clone(),
                        slot,
                    }],
                    Some(row),
                );
                self.unify_or_taint(&target_ty, &wanted);
                field_ty
            }
            "field_accessor_function_expr" => {
                let Some(field) = child_of_kind(node, "lower_case_identifier") else {
                    self.taint();
                    return Ty::Unknown;
                };
                let field_ty = self.fresh();
                let slot = self.use_field(m, field, node);
                let row = self.fresh();
                let taken = record(
                    vec![Field {
                        name: text(field, source).into(),
                        ty: field_ty.clone(),
                        slot,
                    }],
                    Some(row),
                );
                fun(taken, field_ty)
            }
            "record_expr" => {
                let mut fields = Vec::new();
                for field in field_children(node, "field") {
                    let Some(name) = field.child_by_field_name("name") else {
                        continue;
                    };
                    let slot = self.use_field(m, name, node);
                    let ty = match field.child_by_field_name("expression") {
                        Some(expression) => self.infer(m, expression),
                        None => {
                            self.taint();
                            Ty::Unknown
                        }
                    };
                    fields.push(Field {
                        name: text(name, source).into(),
                        ty,
                        slot,
                    });
                }
                match node.child_by_field_name("baseRecord") {
                    Some(base) => {
                        let base_name =
                            child_of_kind(base, "lower_case_identifier").unwrap_or(base);
                        let base_ty = self.value_type(m, text(base_name, source), base_name);
                        let row = self.fresh();
                        self.unify_or_taint(&base_ty, &record(fields, Some(row)));
                        base_ty
                    }
                    None => record(fields, None),
                }
            }
            "list_expr" => {
                let element = self.fresh();
                for item in field_children(node, "exprList") {
                    let ty = self.infer(m, item);
                    self.unify_or_taint(&element, &ty);
                }
                con("List", "List", vec![element])
            }
            "tuple_expr" => {
                let types = field_children(node, "expr")
                    .into_iter()
                    .map(|e| self.infer(m, e))
                    .collect();
                Ty::Tuple(Rc::new(types))
            }
            "parenthesized_expr" => match node.child_by_field_name("expression") {
                Some(inner) => self.infer(m, inner),
                None => {
                    self.taint();
                    Ty::Unknown
                }
            },
            "anonymous_function_expr" => {
                self.scopes.push(HashMap::new());
                let mut params = Vec::new();
                for pattern in field_children(node, "param") {
                    let ty = self.fresh();
                    self.bind_pattern(m, pattern, &ty);
                    params.push(ty);
                }
                let mut ty = match node.child_by_field_name("expr") {
                    Some(body) => self.infer(m, body),
                    None => {
                        self.taint();
                        Ty::Unknown
                    }
                };
                self.scopes.pop();
                while let Some(param) = params.pop() {
                    ty = fun(param, ty);
                }
                ty
            }
            "if_else_expr" => {
                let parts = field_children(node, "exprList");
                let result = self.fresh();
                let bool_ty = con("Basics", "Bool", Vec::new());
                for (index, part) in parts.iter().enumerate() {
                    let ty = self.infer(m, *part);
                    if index % 2 == 0 && index + 1 < parts.len() {
                        self.unify_or_taint(&ty, &bool_ty);
                    } else {
                        self.unify_or_taint(&result, &ty);
                    }
                }
                result
            }
            "case_of_expr" => {
                let scrutinee = match node.child_by_field_name("expr") {
                    Some(expr) => self.infer(m, expr),
                    None => {
                        self.taint();
                        Ty::Unknown
                    }
                };
                let result = self.fresh();
                for branch in field_children(node, "branch") {
                    self.scopes.push(HashMap::new());
                    if let Some(pattern) = branch.child_by_field_name("pattern") {
                        self.bind_pattern(m, pattern, &scrutinee);
                    }
                    if let Some(expr) = branch.child_by_field_name("expr") {
                        let ty = self.infer(m, expr);
                        self.unify_or_taint(&result, &ty);
                    }
                    self.scopes.pop();
                }
                result
            }
            "let_in_expr" => self.infer_let(m, node),
            "negate_expr" => {
                let inner = named_children(node)
                    .into_iter()
                    .rfind(|c| c.kind() != "operator_identifier");
                match inner {
                    Some(inner) => self.infer(m, inner),
                    None => {
                        self.taint();
                        Ty::Unknown
                    }
                }
            }
            "number_constant_expr" => {
                if text(node, source).contains('.') {
                    con("Basics", "Float", Vec::new())
                } else {
                    self.fresh()
                }
            }
            "string_constant_expr" => con("String", "String", Vec::new()),
            "char_constant_expr" => con("Char", "Char", Vec::new()),
            "unit_expr" => Ty::Unit,
            "operator_as_function_expr" => match node.child_by_field_name("operator") {
                Some(op) => self.operator_type(m, text(op, source)),
                None => {
                    self.taint();
                    Ty::Unknown
                }
            },
            _ => {
                self.taint();
                Ty::Unknown
            }
        }
    }

    /// The result of applying a function of type `function` to an argument of type `arg`
    fn apply(&mut self, function: &Ty, arg: &Ty) -> Ty {
        let function = self.prune(function);
        if let Ty::Fun(f) = &function {
            self.unify_or_taint(&f.0, arg);
            return f.1.clone();
        }
        let result = self.fresh();
        let wanted = fun(arg.clone(), result.clone());
        self.unify_or_taint(&function, &wanted);
        result
    }

    fn operator_type(&mut self, m: usize, op: &str) -> Ty {
        let Some((target, value, _, _)) = self.resolve_operator(m, op) else {
            self.taint();
            return Ty::Unknown;
        };
        match self.value_scheme(target, &value) {
            Some(scheme) => self.instantiate(&scheme),
            None => {
                self.taint();
                Ty::Unknown
            }
        }
    }

    /// Operators group by their precedence and associativity, which their packages declare
    fn infer_operators(&mut self, m: usize, node: Node<'t>) -> Ty {
        let source = self.modules[m].source;
        let mut operands: Vec<Ty> = Vec::new();
        let mut operators: Vec<(Ty, u32, bool)> = Vec::new();
        for part in field_children(node, "part") {
            if part.kind() != "operator" {
                let ty = self.infer(m, part);
                operands.push(ty);
                continue;
            }
            let op = text(part, source).trim();
            let (precedence, right) = match self.resolve_operator(m, op) {
                Some((_, _, precedence, right)) => (precedence, right),
                None => (9, false),
            };
            while let Some(&(_, top, _)) = operators.last() {
                if top > precedence || top == precedence && !right {
                    self.reduce(&mut operands, &mut operators);
                } else {
                    break;
                }
            }
            let ty = self.operator_type(m, op);
            operators.push((ty, precedence, right));
        }
        while !operators.is_empty() {
            self.reduce(&mut operands, &mut operators);
        }
        operands.pop().unwrap_or(Ty::Unknown)
    }

    fn reduce(&mut self, operands: &mut Vec<Ty>, operators: &mut Vec<(Ty, u32, bool)>) {
        let (op, _, _) = operators.pop().expect("an operator to reduce");
        let (Some(right), Some(left)) = (operands.pop(), operands.pop()) else {
            self.taint();
            operands.push(Ty::Unknown);
            return;
        };
        let partial = self.apply(&op, &left);
        let result = self.apply(&partial, &right);
        operands.push(result);
    }

    /// A use of a field in an expression or a pattern, with a slot of its own
    fn use_field(&mut self, m: usize, name: Node<'t>, container: Node<'t>) -> u32 {
        let slot = self.new_slot();
        if text(name, self.modules[m].source) == &*self.field {
            self.occurrences.push(Occurrence {
                module: m,
                node: name,
                owner: Owner::Use,
                slot,
                declaration: self.declaration_stack.last().copied(),
                container,
                bound: Vec::new(),
            });
        }
        slot
    }

    fn infer_let(&mut self, m: usize, node: Node<'t>) -> Ty {
        let source = self.modules[m].source;
        let mut annotations: HashMap<Name, Node<'t>> = HashMap::new();
        let mut declarations = Vec::new();
        for child in named_children(node) {
            match child.kind() {
                "type_annotation" => {
                    if let (Some(name), Some(ty)) = (
                        child.child_by_field_name("name"),
                        child.child_by_field_name("typeExpression"),
                    ) {
                        annotations.insert(text(name, source).into(), ty);
                    }
                }
                "value_declaration" => declarations.push(child),
                _ => {}
            }
        }
        self.scopes.push(HashMap::new());
        let level = self.level;

        // Annotated bindings are in scope with their annotation from the start
        let mut annotated = Vec::new();
        let mut rest = Vec::new();
        for declaration in &declarations {
            let name = declared_name(*declaration, source);
            match name.as_ref().and_then(|n| annotations.get(n)) {
                Some(annotation) => {
                    self.level = level + 1;
                    let mut vars = TypeVars {
                        map: HashMap::new(),
                        new_vars: NewVars::Rigid,
                        tainted: false,
                    };
                    let ty = self.convert(m, *annotation, &mut vars, &Owner::Annotation);
                    self.level = level;
                    if vars.tainted {
                        self.taint();
                    }
                    let scheme = self.generalize(&ty, vars.tainted);
                    let name = name.expect("an annotated binding has a name");
                    self.scopes.last_mut().expect("the let's scope").insert(
                        name,
                        Local {
                            scheme: Rc::new(scheme),
                            binder: None,
                        },
                    );
                    annotated.push((*declaration, ty, vars.map));
                }
                None => rest.push(*declaration),
            }
        }

        // The others in the order of what they use, each group of mutually recursive ones generalized together
        let names: Vec<Vec<Name>> = rest.iter().map(|d| bound_names(*d, source)).collect();
        for group in dependency_groups(&rest, &names, source) {
            self.level = level + 1;
            let mut placeholders = Vec::new();
            for &index in &group {
                if let Some(name) = declared_name(rest[index], source) {
                    let placeholder = self.fresh();
                    self.scopes.last_mut().expect("the let's scope").insert(
                        name,
                        Local {
                            scheme: Rc::new(Scheme::mono(placeholder.clone())),
                            binder: None,
                        },
                    );
                    placeholders.push((index, placeholder));
                }
            }
            let mut bound: Vec<(Name, Local)> = Vec::new();
            for &index in &group {
                let declaration = rest[index];
                if let Some(pattern) = declaration.child_by_field_name("pattern") {
                    // A destructuring `( a, b ) = ...`
                    let ty = match declaration.child_by_field_name("body") {
                        Some(body) => self.infer(m, body),
                        None => Ty::Unknown,
                    };
                    self.scopes.push(HashMap::new());
                    self.bind_pattern(m, pattern, &ty);
                    let scope = self.scopes.pop().expect("the pattern's scope");
                    let mut scope: Vec<(Name, Local)> = scope.into_iter().collect();
                    scope.sort_by(|a, b| a.0.cmp(&b.0));
                    bound.extend(scope);
                } else {
                    let ty = self.infer_function(m, declaration);
                    if let Some((_, placeholder)) = placeholders.iter().find(|(i, _)| *i == index) {
                        let placeholder = placeholder.clone();
                        self.unify_or_taint(&placeholder, &ty);
                    }
                }
            }
            self.level = level;
            for (index, placeholder) in placeholders {
                if let Some(name) = declared_name(rest[index], source) {
                    let scheme = self.generalize(&placeholder, false);
                    self.scopes.last_mut().expect("the let's scope").insert(
                        name,
                        Local {
                            scheme: Rc::new(scheme),
                            binder: None,
                        },
                    );
                }
            }
            for (name, local) in bound {
                let scheme = self.generalize(&local.scheme.ty, false);
                self.scopes.last_mut().expect("the let's scope").insert(
                    name,
                    Local {
                        scheme: Rc::new(scheme),
                        binder: local.binder,
                    },
                );
            }
        }

        for (declaration, expected, names) in annotated {
            self.level = level + 1;
            self.type_scopes.push(names);
            let ty = self.infer_function(m, declaration);
            self.unify_or_taint(&ty, &expected);
            self.type_scopes.pop();
            self.level = level;
        }

        let ty = match node.child_by_field_name("body") {
            Some(body) => self.infer(m, body),
            None => {
                self.taint();
                Ty::Unknown
            }
        };
        self.scopes.pop();
        ty
    }

    // --- patterns

    fn bind_local(&mut self, name: Name, ty: Ty, binder: Option<usize>) {
        if let Some(scope) = self.scopes.last_mut() {
            scope.insert(
                name,
                Local {
                    scheme: Rc::new(Scheme::mono(ty)),
                    binder,
                },
            );
        }
    }

    fn bind_pattern(&mut self, m: usize, node: Node<'t>, ty: &Ty) {
        let outer = self.current.replace((m, node));
        self.bind_pattern_here(m, node, ty);
        self.current = outer;
    }

    fn bind_pattern_here(&mut self, m: usize, node: Node<'t>, ty: &Ty) {
        let source = self.modules[m].source;
        match node.kind() {
            "pattern" => {
                if let Some(child) = node.child_by_field_name("child") {
                    self.bind_pattern(m, child, ty);
                }
                if let Some(alias) = node.child_by_field_name("patternAs") {
                    self.bind_local(text(alias, source).into(), ty.clone(), None);
                }
            }
            "lower_pattern" => self.bind_local(text(node, source).into(), ty.clone(), None),
            "anything_pattern" => {}
            "record_pattern" => {
                let mut fields = Vec::new();
                for field in field_children(node, "patternList") {
                    let Some(name) = child_of_kind(field, "lower_case_identifier") else {
                        continue;
                    };
                    let slot = self.use_field(m, name, node);
                    let binder =
                        (text(name, source) == &*self.field).then(|| self.occurrences.len() - 1);
                    let field_ty = self.fresh();
                    self.bind_local(text(name, source).into(), field_ty.clone(), binder);
                    fields.push(Field {
                        name: text(name, source).into(),
                        ty: field_ty,
                        slot,
                    });
                }
                let row = self.fresh();
                self.unify_or_taint(ty, &record(fields, Some(row)));
            }
            "tuple_pattern" => {
                let parts = field_children(node, "pattern");
                let types: Vec<Ty> = parts.iter().map(|_| self.fresh()).collect();
                self.unify_or_taint(ty, &Ty::Tuple(Rc::new(types.clone())));
                for (part, part_ty) in parts.into_iter().zip(types) {
                    self.bind_pattern(m, part, &part_ty);
                }
            }
            "union_pattern" | "nullary_constructor_argument_pattern" => {
                let constructor = node
                    .child_by_field_name("constructor")
                    .or_else(|| child_of_kind(node, "upper_case_qid"));
                let args = field_children(node, "argPattern");
                let mut constructor_ty = match constructor {
                    Some(constructor) => self.value_type(m, text(constructor, source), constructor),
                    None => Ty::Unknown,
                };
                if matches!(constructor_ty, Ty::Unknown) {
                    self.taint();
                }
                for arg in args {
                    let arg_ty = match self.prune(&constructor_ty) {
                        Ty::Fun(f) => {
                            constructor_ty = f.1.clone();
                            f.0.clone()
                        }
                        Ty::Unknown => Ty::Unknown,
                        _ => {
                            self.taint();
                            constructor_ty = Ty::Unknown;
                            Ty::Unknown
                        }
                    };
                    self.bind_pattern(m, arg, &arg_ty);
                }
                self.unify_or_taint(ty, &constructor_ty);
            }
            "list_pattern" => {
                let element = self.fresh();
                self.unify_or_taint(ty, &con("List", "List", vec![element.clone()]));
                for part in field_children(node, "part") {
                    self.bind_pattern(m, part, &element);
                }
            }
            "cons_pattern" => {
                let element = self.fresh();
                let list = con("List", "List", vec![element.clone()]);
                self.unify_or_taint(ty, &list);
                let parts = field_children(node, "part");
                let count = parts.len();
                for (index, part) in parts.into_iter().enumerate() {
                    let part_ty = if index + 1 == count {
                        list.clone()
                    } else {
                        element.clone()
                    };
                    self.bind_pattern(m, part, &part_ty);
                }
            }
            "string_constant_expr" => self.unify_or_taint(ty, &con("String", "String", Vec::new())),
            "char_constant_expr" => self.unify_or_taint(ty, &con("Char", "Char", Vec::new())),
            "number_constant_expr" => {
                if text(node, source).contains('.') {
                    self.unify_or_taint(ty, &con("Basics", "Float", Vec::new()));
                }
            }
            "unit_expr" => self.unify_or_taint(ty, &Ty::Unit),
            _ => self.taint(),
        }
    }

    // --- the answer

    fn place(&self, occurrence: &Occurrence) -> String {
        self.place_of(occurrence.module, occurrence.node)
    }

    fn place_of(&self, m: usize, node: Node) -> String {
        let path = url_path(self.modules[m].uri.unwrap_or(""));
        let at = node.start_position();
        format!("{}:{}:{}", path, at.row + 1, at.column + 1)
    }

    fn plan_rename(
        &mut self,
        uri: &str,
        node_id: usize,
        new_name: &str,
    ) -> Result<Vec<FieldEdit>, String> {
        let field = self.field.clone();
        let class = self.one_record(uri, node_id).map_err(|reason| {
            format!("Renaming the field `{field}` is not possible: {reason}. Nothing was changed.")
        })?;

        // The new name must not be one that the records or the bound variables have already
        for &i in &class {
            let o = &self.occurrences[i];
            let source = self.modules[o.module].source;
            if record_has_field(o.container, source, new_name) {
                return Err(format!(
                    "Renaming the field `{field}` to `{new_name}` is not possible: the record at {} already has a field `{new_name}`. Nothing was changed.",
                    self.place(o)
                ));
            }
            if o.container.kind() == "record_pattern"
                && name_is_taken(o.node, source, new_name, &self.modules[o.module])
            {
                return Err(format!(
                    "Renaming the field `{field}` to `{new_name}` is not possible: the pattern at {} binds a variable `{field}`, and `{new_name}` already exists where it is used. Nothing was changed.",
                    self.place(o)
                ));
            }
        }

        let removal = self.uses_of(&class);
        let mut edits = removal.fields;
        edits.extend(removal.bound);
        sort_edits(&mut edits);
        Ok(edits)
    }

    /// Every place of the field that belongs to the record of the field at
    /// the node, whatever other records the values pass through
    fn plan_references(&mut self, uri: &str, node_id: usize) -> Result<Vec<FieldEdit>, String> {
        let field = self.field.clone();
        let class = self.class_of(uri, node_id).map_err(|reason| {
            format!("The server cannot list the uses of the field `{field}`: {reason}")
        })?;
        let removal = self.uses_of(&class);
        let mut edits = removal.fields;
        edits.extend(removal.bound);
        sort_edits(&mut edits);
        Ok(edits)
    }

    /// The uses that removing the field from its record changes. The
    /// arguments of the record's constructor follow its fields, so a call of
    /// it would take one argument too many.
    fn plan_removal(&mut self, uri: &str, node_id: usize) -> Result<FieldRemoval, String> {
        let field = self.field.clone();
        let refusal = |reason: String| {
            format!("Removing the field `{field}` is not possible: {reason}. Nothing was changed.")
        };
        let class = self.one_record(uri, node_id).map_err(refusal)?;
        let mut calls: Vec<String> = Vec::new();
        for &i in &class {
            if let Owner::Alias(module, name) = &self.occurrences[i].owner {
                for ((target, called), (m, node)) in &self.constructor_calls {
                    if &self.modules[*target].name == module && called == name {
                        let place = self.place_of(*m, *node);
                        if !calls.contains(&place) {
                            calls.push(place);
                        }
                    }
                }
            }
        }
        calls.sort();
        if let Some(first) = calls.first() {
            let alias = class
                .iter()
                .find_map(|i| match &self.occurrences[*i].owner {
                    Owner::Alias(_, name) => Some(name.to_string()),
                    _ => None,
                })
                .unwrap_or_default();
            return Err(refusal(format!(
                "the record alias {alias} is called as a constructor at {first}{}, whose arguments follow its fields",
                match calls.len() {
                    1 => String::new(),
                    n => format!(" and at {} more places", n - 1),
                }
            )));
        }
        let mut removal = self.uses_of(&class);
        sort_edits(&mut removal.fields);
        sort_edits(&mut removal.bound);
        Ok(removal)
    }

    /// The occurrences of the field in the record of the one at the node,
    /// where that record is the record of a single type of the project and
    /// the server can tell every use of it
    fn one_record(&mut self, uri: &str, node_id: usize) -> Result<Vec<usize>, String> {
        let class = self.class_of(uri, node_id)?;
        let root = self.find(self.occurrences[class[0]].slot);
        let package_roots: Vec<(u32, String)> = (0..self.package_slots.len())
            .map(|i| {
                let (slot, place) = self.package_slots[i].clone();
                (self.find(slot), place)
            })
            .collect();
        if let Some((_, place)) = package_roots.iter().find(|(r, _)| *r == root) {
            return Err(format!(
                "the record that it belongs to is also a {place} of a package, whose field cannot change"
            ));
        }
        let mut owners: Vec<(&Owner, usize)> = Vec::new();
        for &i in &class {
            let owner = &self.occurrences[i].owner;
            if matches!(owner, Owner::Alias(..) | Owner::Union(..))
                && !owners.iter().any(|(o, _)| *o == owner)
            {
                owners.push((owner, i));
            }
        }
        if owners.len() > 1 {
            let named: Vec<String> = owners
                .iter()
                .map(|(owner, i)| {
                    format!(
                        "{} at {}",
                        owner_name(owner),
                        self.place(&self.occurrences[*i])
                    )
                })
                .collect();
            let path = self.joined_at(
                self.occurrences[owners[0].1].slot,
                self.occurrences[owners[1].1].slot,
            );
            let through = if path.is_empty() {
                String::new()
            } else {
                format!(", as at {}", path.join(" and "))
            };
            return Err(format!(
                "the same values pass through records of {}{}, so that their fields have to keep one name",
                named.join(" and "),
                through
            ));
        }
        if owners.is_empty()
            && !class
                .iter()
                .any(|i| self.occurrences[*i].owner == Owner::Annotation)
        {
            return Err("no record type that is written down declares it".to_string());
        }
        Ok(class)
    }

    /// A use that no record claims, in code that the inference could not
    /// type, could be one of any record's, so where there is one no list of
    /// uses is sure
    fn check_sure(&mut self) -> Result<(), String> {
        let roots: Vec<u32> = (0..self.occurrences.len())
            .map(|i| {
                let slot = self.occurrences[i].slot;
                self.find(slot)
            })
            .collect();
        let package_roots: Vec<u32> = (0..self.package_slots.len())
            .map(|i| {
                let slot = self.package_slots[i].0;
                self.find(slot)
            })
            .collect();
        let claimed: HashSet<u32> = (0..self.occurrences.len())
            .filter(|i| self.occurrences[*i].owner != Owner::Use)
            .map(|i| roots[i])
            .chain(package_roots)
            .collect();
        let mut unsure: Vec<usize> = (0..self.occurrences.len())
            .filter(|i| {
                let o = &self.occurrences[*i];
                !claimed.contains(&roots[*i])
                    && o.declaration.is_some_and(|d| self.tainted[d].is_some())
            })
            .collect();
        unsure.sort_by_key(|i| (self.place_key(*i)));
        let Some(first) = unsure.first() else {
            return Ok(());
        };
        let occurrence = &self.occurrences[*first];
        let cause = occurrence
            .declaration
            .and_then(|d| self.tainted[d])
            .map(|(m, node)| {
                let snippet: String = text(node, self.modules[m].source)
                    .split_whitespace()
                    .collect::<Vec<_>>()
                    .join(" ")
                    .chars()
                    .take(60)
                    .collect();
                format!(
                    ", because it could not type `{}` at {}",
                    snippet,
                    self.place_of(m, node)
                )
            })
            .unwrap_or_default();
        Err(format!(
            "the server could not tell the type of the record at {}{}, so it cannot say whether that use belongs to the same record{}",
            self.place(occurrence),
            match unsure.len() {
                1 => String::new(),
                n => format!(" and at {} more places", n - 1),
            },
            cause
        ))
    }

    /// The occurrences of the field in the record of the one at the node,
    /// where the server can tell every use of it
    fn class_of(&mut self, uri: &str, node_id: usize) -> Result<Vec<usize>, String> {
        let target = self.occurrence_at(uri, node_id)?;
        let root = self.find(self.occurrences[target].slot);
        let class: Vec<usize> = (0..self.occurrences.len())
            .filter(|i| {
                let slot = self.occurrences[*i].slot;
                self.find(slot) == root
            })
            .collect();
        self.check_sure()?;
        Ok(class)
    }

    fn occurrence_at(&self, uri: &str, node_id: usize) -> Result<usize, String> {
        self.occurrences
            .iter()
            .position(|o| self.modules[o.module].uri == Some(uri) && o.node.id() == node_id)
            .ok_or_else(|| "the server could not read the code around it".to_string())
    }

    /// The places of the occurrences, and of the variables that their record patterns bind
    fn uses_of(&self, class: &[usize]) -> FieldRemoval {
        let mut removal = FieldRemoval {
            fields: Vec::new(),
            bound: Vec::new(),
        };
        for &i in class {
            let o = &self.occurrences[i];
            let uri = self.modules[o.module].uri.unwrap_or("").to_string();
            removal.fields.push(FieldEdit {
                uri: uri.clone(),
                range: range_of(o.node),
            });
            for used in &o.bound {
                removal.bound.push(FieldEdit {
                    uri: uri.clone(),
                    range: range_of(*used),
                });
            }
        }
        removal
    }

    /// The places in the project where the inference joined the slots that lead from `from` to `to`
    fn joined_at(&self, from: u32, to: u32) -> Vec<String> {
        let mut edges: HashMap<u32, Vec<usize>> = HashMap::new();
        for (index, (a, b, _)) in self.joins.iter().enumerate() {
            edges.entry(*a).or_default().push(index);
            edges.entry(*b).or_default().push(index);
        }
        let mut came_by: HashMap<u32, Option<usize>> = HashMap::from([(from, None)]);
        let mut queue = std::collections::VecDeque::from([from]);
        while let Some(slot) = queue.pop_front() {
            if slot == to {
                break;
            }
            for &edge in edges.get(&slot).into_iter().flatten() {
                let (a, b, _) = self.joins[edge];
                let next = if a == slot { b } else { a };
                if let std::collections::hash_map::Entry::Vacant(entry) = came_by.entry(next) {
                    entry.insert(Some(edge));
                    queue.push_back(next);
                }
            }
        }
        let mut places = Vec::new();
        let mut slot = to;
        while let Some(Some(edge)) = came_by.get(&slot) {
            let (a, b, at) = self.joins[*edge];
            if let Some((m, node)) = at {
                if self.is_project(m) {
                    let place = self.place_of(m, node);
                    if !places.contains(&place) {
                        places.push(place);
                    }
                }
            }
            slot = if a == slot { b } else { a };
        }
        places.reverse();
        places.truncate(3);
        places
    }

    fn place_key(&self, i: usize) -> (String, usize, usize) {
        let o = &self.occurrences[i];
        let at = o.node.start_position();
        (
            self.modules[o.module].uri.unwrap_or("").to_string(),
            at.row,
            at.column,
        )
    }
}

/// In the order of the files and of the places in them, each once
fn sort_edits(edits: &mut Vec<FieldEdit>) {
    edits.sort_by(|a, b| {
        (&a.uri, a.range.start.line, a.range.start.character).cmp(&(
            &b.uri,
            b.range.start.line,
            b.range.start.character,
        ))
    });
    edits.dedup();
}

fn owner_name(owner: &Owner) -> String {
    match owner {
        Owner::Alias(module, name) | Owner::Union(module, name) => format!("{module}.{name}"),
        Owner::Annotation => "an annotation".to_string(),
        Owner::Use => "a use".to_string(),
    }
}

fn is_type_node(node: Node) -> bool {
    matches!(
        node.kind(),
        "type_expression" | "type_ref" | "type_variable" | "record_type" | "tuple_type"
    )
}

fn split_qualified(full: &str) -> (Option<&str>, &str) {
    match full.rfind('.') {
        Some(dot) => (Some(&full[..dot]), &full[dot + 1..]),
        None => (None, full),
    }
}

fn last_child_of_kind<'t>(node: Node<'t>, kind: &str) -> Option<Node<'t>> {
    let mut cursor = node.walk();
    let found = node
        .children(&mut cursor)
        .filter(|c| c.kind() == kind)
        .last();
    found
}

/// The record type that a type expression is, through brackets
fn record_type_of(node: Node) -> Option<Node> {
    match node.kind() {
        "record_type" => Some(node),
        "type_expression" => {
            let parts: Vec<Node> = named_children(node)
                .into_iter()
                .filter(|c| is_type_node(*c))
                .collect();
            match parts.as_slice() {
                [only] => record_type_of(*only),
                _ => None,
            }
        }
        _ => None,
    }
}

/// The names that a let declaration binds: its function's, or those of its pattern
fn bound_names(declaration: Node, source: &str) -> Vec<Name> {
    if let Some(name) = declared_name(declaration, source) {
        return vec![name];
    }
    let mut names = Vec::new();
    if let Some(pattern) = declaration.child_by_field_name("pattern") {
        collect_pattern_names(pattern, source, &mut names);
    }
    names
}

fn collect_pattern_names(node: Node, source: &str, names: &mut Vec<Name>) {
    if node.kind() == "lower_pattern" {
        names.push(text(node, source).into());
        return;
    }
    for child in named_children(node) {
        collect_pattern_names(child, source, names);
    }
}

/// The groups of let declarations that use one another, each after the ones it uses
fn dependency_groups(declarations: &[Node], names: &[Vec<Name>], source: &str) -> Vec<Vec<usize>> {
    let owner_of: HashMap<&str, usize> = names
        .iter()
        .enumerate()
        .flat_map(|(i, names)| names.iter().map(move |n| (&**n, i)))
        .collect();
    let uses: Vec<Vec<usize>> = declarations
        .iter()
        .map(|d| {
            let mut used = Vec::new();
            if let Some(body) = d.child_by_field_name("body") {
                collect_uses(body, source, &owner_of, &mut used);
            }
            used.sort_unstable();
            used.dedup();
            used
        })
        .collect();
    strongly_connected(&uses)
}

fn collect_uses(node: Node, source: &str, owner_of: &HashMap<&str, usize>, used: &mut Vec<usize>) {
    match node.kind() {
        "value_expr" | "record_base_identifier" => {
            let name = text(node, source);
            if let Some(&i) = owner_of.get(name) {
                used.push(i);
            }
        }
        _ => {}
    }
    for child in named_children(node) {
        collect_uses(child, source, owner_of, used);
    }
}

/// Tarjan's algorithm, which gives each group after the groups it reaches
fn strongly_connected(edges: &[Vec<usize>]) -> Vec<Vec<usize>> {
    struct State {
        index: Vec<Option<usize>>,
        low: Vec<usize>,
        on_stack: Vec<bool>,
        stack: Vec<usize>,
        next: usize,
        groups: Vec<Vec<usize>>,
    }
    fn visit(v: usize, edges: &[Vec<usize>], s: &mut State) {
        s.index[v] = Some(s.next);
        s.low[v] = s.next;
        s.next += 1;
        s.stack.push(v);
        s.on_stack[v] = true;
        for &w in &edges[v] {
            match s.index[w] {
                None => {
                    visit(w, edges, s);
                    s.low[v] = s.low[v].min(s.low[w]);
                }
                Some(index) if s.on_stack[w] => s.low[v] = s.low[v].min(index),
                _ => {}
            }
        }
        if Some(s.low[v]) == s.index[v] {
            let mut group = Vec::new();
            while let Some(w) = s.stack.pop() {
                s.on_stack[w] = false;
                group.push(w);
                if w == v {
                    break;
                }
            }
            group.sort_unstable();
            s.groups.push(group);
        }
    }
    let n = edges.len();
    let mut state = State {
        index: vec![None; n],
        low: vec![0; n],
        on_stack: vec![false; n],
        stack: Vec::new(),
        next: 0,
        groups: Vec::new(),
    };
    for v in 0..n {
        if state.index[v].is_none() {
            visit(v, edges, &mut state);
        }
    }
    state.groups
}

fn record_has_field(container: Node, source: &str, name: &str) -> bool {
    let fields = match container.kind() {
        "record_type" => field_children(container, "fieldType"),
        "record_expr" => field_children(container, "field"),
        "record_pattern" => {
            return field_children(container, "patternList")
                .into_iter()
                .any(|p| text(p, source) == name)
        }
        _ => return false,
    };
    fields.into_iter().any(|f| {
        f.child_by_field_name("name")
            .is_some_and(|n| text(n, source) == name)
    })
}

/// Whether a variable `name` would clash with a name of the module or of the
/// declaration that `node` stands in, which Elm does not let one shadow
fn name_is_taken(node: Node, source: &str, name: &str, module: &Module) -> bool {
    if module.values.contains_key(name) {
        return true;
    }
    let mut top = node;
    while let Some(parent) = top.parent() {
        if parent.kind() == "file" {
            break;
        }
        top = parent;
    }
    binds_name(top, source, name)
}

fn binds_name(node: Node, source: &str, name: &str) -> bool {
    if node.kind() == "lower_pattern" && text(node, source) == name {
        return true;
    }
    if node.kind() == "function_declaration_left" {
        if let Some(n) = child_of_kind(node, "lower_case_identifier") {
            if text(n, source) == name {
                return true;
            }
        }
    }
    named_children(node)
        .into_iter()
        .any(|c| binds_name(c, source, name))
}

fn range_of(node: Node) -> Range {
    let (start, end) = (node.start_position(), node.end_position());
    Range {
        start: Position::new(start.row as u32, start.column as u32),
        end: Position::new(end.row as u32, end.column as u32),
    }
}

fn url_path(uri: &str) -> String {
    Url::parse(uri)
        .ok()
        .and_then(|u| u.to_file_path().ok())
        .map(|p| p.display().to_string())
        .unwrap_or_else(|| uri.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A few modules of elm/core and elm/browser, with their types and without their code
    const PACKAGE: &[(&str, &str)] = &[
        (
            "Basics.elm",
            "module Basics exposing (Int, Float, Bool(..), identity, always, (++), (|>), (<|), (==), (+))

infix right 0 (<|) = apL
infix left  0 (|>) = apR
infix non   4 (==) = eq
infix right 5 (++) = append
infix left  6 (+)  = add

type Int = Int
type Float = Float
type Bool = True | False

identity : a -> a
always : a -> b -> a
apL : (a -> b) -> a -> b
apR : a -> (a -> b) -> b
eq : a -> a -> Bool
append : appendable -> appendable -> appendable
add : number -> number -> number
",
        ),
        (
            "String.elm",
            "module String exposing (String, fromInt)

type String = String

fromInt : Int -> String
",
        ),
        ("Char.elm", "module Char exposing (Char)\n\ntype Char = Char\n"),
        (
            "List.elm",
            "module List exposing (map, filter, (::))

infix right 5 (::) = cons

cons : a -> List a -> List a
map : (a -> b) -> List a -> List b
filter : (a -> Bool) -> List a -> List a
",
        ),
        (
            "Maybe.elm",
            "module Maybe exposing (Maybe(..), map)

type Maybe a = Just a | Nothing

map : (a -> b) -> Maybe a -> Maybe b
",
        ),
        ("Platform/Cmd.elm", "module Platform.Cmd exposing (Cmd, none)\n\ntype Cmd msg = Cmd\n\nnone : Cmd msg\n"),
        ("Platform/Sub.elm", "module Platform.Sub exposing (Sub)\n\ntype Sub msg = Sub\n"),
        (
            "Browser.elm",
            "module Browser exposing (Document)

import Browser.Internal

type alias Document msg =
    Browser.Internal.Page msg
",
        ),
        (
            "Browser/Internal.elm",
            "module Browser.Internal exposing (Page)

type alias Page msg =
    { title : String, body : List msg }
",
        ),
    ];

    struct Project {
        _packages: tempfile::TempDir,
        package_dir: PathBuf,
        files: Vec<(String, String, Tree)>,
    }

    impl Project {
        fn new(files: &[(&str, &str)]) -> Self {
            let packages = tempfile::tempdir().unwrap();
            for (path, source) in PACKAGE {
                let path = packages.path().join("src").join(path);
                std::fs::create_dir_all(path.parent().unwrap()).unwrap();
                std::fs::write(path, source).unwrap();
            }
            let mut parser = tree_sitter::Parser::new();
            parser
                .set_language(&tree_sitter_elm::LANGUAGE.into())
                .unwrap();
            let files = files
                .iter()
                .map(|(path, source)| {
                    let tree = parser.parse(source, None).unwrap();
                    (
                        format!("file:///project/src/{path}"),
                        source.to_string(),
                        tree,
                    )
                })
                .collect();
            Project {
                package_dir: packages.path().to_path_buf(),
                _packages: packages,
                files,
            }
        }

        /// The module `path` and the place of the first `marker` in it
        fn at(&self, path: &str, marker: &str) -> (String, tree_sitter::Point) {
            let uri = format!("file:///project/src/{path}");
            let (_, source, _) = self.files.iter().find(|(u, _, _)| *u == uri).unwrap();
            let offset = source.find(marker).expect("the marker");
            let row = source[..offset].matches('\n').count();
            let column = offset - source[..offset].rfind('\n').map_or(0, |n| n + 1);
            (uri, tree_sitter::Point::new(row, column))
        }

        fn modules(&self) -> Vec<SourceModule<'_>> {
            self.files
                .iter()
                .map(|(uri, source, tree)| SourceModule { uri, source, tree })
                .collect()
        }

        /// The uses of the field at the first `marker` in `path`, as `path:line:column`
        fn references(&self, path: &str, marker: &str) -> Result<Vec<String>, String> {
            let (uri, point) = self.at(path, marker);
            let edits = field_references(
                &self.modules(),
                std::slice::from_ref(&self.package_dir),
                &uri,
                point,
            )
            .expect("a field at the marker")?;
            Ok(places(&edits))
        }

        /// What removing the field at the first `marker` in `path` changes
        fn removal(&self, path: &str, marker: &str) -> Result<FieldRemoval, String> {
            let (uri, point) = self.at(path, marker);
            remove_field(
                &self.modules(),
                std::slice::from_ref(&self.package_dir),
                &uri,
                point,
            )
            .expect("a field at the marker")
        }

        /// The places that renaming the field at the first `marker` in `path` changes
        fn renamed_places(&self, path: &str, marker: &str) -> Vec<String> {
            let (uri, point) = self.at(path, marker);
            let edits = rename_field(
                &self.modules(),
                std::slice::from_ref(&self.package_dir),
                &uri,
                point,
                "fresh",
            )
            .expect("a field at the marker")
            .unwrap();
            places(&edits)
        }

        /// Rename the field at the first `marker` in `path`, and give each changed file's text
        fn rename(
            &self,
            path: &str,
            marker: &str,
            new_name: &str,
        ) -> Result<Vec<(String, String)>, String> {
            let (uri, point) = self.at(path, marker);
            let edits = rename_field(
                &self.modules(),
                std::slice::from_ref(&self.package_dir),
                &uri,
                point,
                new_name,
            )
            .expect("a field at the marker")?;
            let mut changed = Vec::new();
            for (uri, source, _) in &self.files {
                let mut lines: Vec<String> = source.split('\n').map(str::to_string).collect();
                let mut mine: Vec<&FieldEdit> = edits.iter().filter(|e| &e.uri == uri).collect();
                if mine.is_empty() {
                    continue;
                }
                mine.sort_by_key(|e| {
                    std::cmp::Reverse((e.range.start.line, e.range.start.character))
                });
                for edit in mine {
                    let line = &mut lines[edit.range.start.line as usize];
                    line.replace_range(
                        edit.range.start.character as usize..edit.range.end.character as usize,
                        new_name,
                    );
                }
                changed.push((
                    uri.trim_start_matches("file:///project/src/").to_string(),
                    lines.join("\n"),
                ));
            }
            Ok(changed)
        }
    }

    fn places(edits: &[FieldEdit]) -> Vec<String> {
        edits
            .iter()
            .map(|e| {
                format!(
                    "{}:{}:{}",
                    e.uri.trim_start_matches("file:///project/src/"),
                    e.range.start.line + 1,
                    e.range.start.character + 1
                )
            })
            .collect()
    }

    fn text_of<'a>(changed: &'a [(String, String)], path: &str) -> &'a str {
        changed
            .iter()
            .find(|(p, _)| p == path)
            .map(|(_, t)| t.as_str())
            .unwrap_or_else(|| panic!("{path} did not change"))
    }

    const ACCOUNT: &str = "module Account exposing (Account, Holder(..), Login)


type alias Account =
    { title : String
    , owner : String
    }


type alias Login =
    { account : Account
    , token : String
    }


type Holder
    = Holds Account
    | Nobody
";

    #[test]
    fn uses_whose_record_type_is_not_written_down_are_renamed() {
        let main = "module Main exposing (main)

import Account exposing (Account, Holder(..), Login)


chained : Login -> String
chained login =
    login.account.title


caseBranch : Holder -> String
caseBranch holder =
    case holder of
        Holds account ->
            account.title

        Nobody ->
            \"\"


lambda : List Account -> List String
lambda accounts =
    List.map (\\account -> account.title) accounts


accessor : List Account -> List String
accessor accounts =
    List.map .title accounts


lambdaPattern : List Account -> List String
lambdaPattern accounts =
    List.map (\\{ title } -> title) accounts


letBound : Login -> String
letBound login =
    let
        account =
            login.account
    in
    account.title


piped : List Login -> List String
piped logins =
    logins |> List.map .account |> List.map (\\a -> a.title ++ \"!\")


updated : Account -> Account
updated account =
    let
        rename new =
            { account | title = new }
    in
    rename \"x\"


main : String
main =
    chained { account = { title = \"Savings\", owner = \"Ada\" }, token = \"\" }
";
        let project = Project::new(&[("Account.elm", ACCOUNT), ("Main.elm", main)]);
        let changed = project.rename("Account.elm", "title", "heading").unwrap();
        assert!(text_of(&changed, "Account.elm").contains("{ heading : String"));
        let main = text_of(&changed, "Main.elm");
        assert!(!main.contains("title"), "every use is renamed:\n{main}");
        assert!(main.contains("\\{ heading } -> heading"));
        assert!(main.contains("{ account | heading = new }"));
    }

    #[test]
    fn a_rename_from_a_use_reaches_the_alias() {
        let main = "module Main exposing (label)

import Account exposing (Account)


label : Account -> String
label account =
    account.title
";
        let project = Project::new(&[("Account.elm", ACCOUNT), ("Main.elm", main)]);
        let changed = project.rename("Main.elm", "title\n", "heading").unwrap();
        assert!(text_of(&changed, "Account.elm").contains("{ heading : String"));
        assert!(text_of(&changed, "Main.elm").contains("account.heading"));
    }

    const ITEM: &str = "module Item exposing (Item, describe)


type alias Item =
    { title : String
    , price : Int
    }


describe : Item -> String
describe item =
    item.title
";

    const OLD_ITEM: &str = "module Old.Item exposing (Item, code)


type alias Item =
    { code : Int
    , title : Int
    }


code : Item -> Int
code item =
    item.code
";

    #[test]
    fn an_alias_of_the_same_name_in_another_module_takes_nothing_and_loses_nothing() {
        let main = "module Main exposing (main)

import Item exposing (Item)
import Old.Item
import Old.Item as Legacy


label : Item -> String
label item =
    item.title


old : Old.Item.Item -> Int
old item =
    item.title


legacy : Legacy.Item -> Int
legacy item =
    item.title


main : String
main =
    label { title = \"Lamp\", price = 3 } ++ Item.describe { title = \"Desk\", price = 9 }
";
        // Each HashMap of a run gets other keys, so an answer that hung on their order would vary here
        for _ in 0..20 {
            let project = Project::new(&[
                ("Item.elm", ITEM),
                ("Old/Item.elm", OLD_ITEM),
                ("Main.elm", main),
            ]);
            let changed = project.rename("Item.elm", "title", "heading").unwrap();
            let main = text_of(&changed, "Main.elm");
            assert!(main.contains("label item =\n    item.heading"), "{main}");
            assert!(main.contains("old item =\n    item.title"), "{main}");
            assert!(main.contains("legacy item =\n    item.title"), "{main}");
            assert_eq!(main.matches("heading").count(), 3, "{main}");
            assert!(changed.iter().all(|(path, _)| path != "Old/Item.elm"));
        }
    }

    #[test]
    fn a_record_update_of_another_record_in_a_case_branch_stays() {
        let tile = "module Tile exposing (Tile, show)


type alias Tile =
    { title : String
    , size : Int
    }


show : Tile -> String
show tile =
    tile.title
";
        let draft = "module Draft exposing (Draft, Msg(..), update)


type alias Draft =
    { title : String
    , saved : Bool
    }


type Msg
    = Retitle String
    | Clean


update : Msg -> Draft -> Draft
update msg draft =
    case msg of
        Retitle title ->
            change (\\current -> { current | title = title }) draft

        Clean ->
            { draft | saved = True }


change : (Draft -> Draft) -> Draft -> Draft
change edit draft =
    edit draft
";
        let main = "module Main exposing (main)

import Draft
import Tile


main : String
main =
    Tile.show { title = \"Lamp\", size = 3 } ++ (Draft.update (Draft.Retitle \"T\") { title = \"\", saved = False }).title
";
        let project = Project::new(&[("Tile.elm", tile), ("Draft.elm", draft), ("Main.elm", main)]);
        let changed = project.rename("Tile.elm", "title", "heading").unwrap();
        assert!(changed.iter().all(|(path, _)| path != "Draft.elm"));
        let main = text_of(&changed, "Main.elm");
        assert!(main.contains("Tile.show { heading = \"Lamp\""));
        assert!(main.contains("{ title = \"\", saved = False }).title"));
    }

    #[test]
    fn a_record_pattern_on_a_record_type_without_an_alias_stays() {
        let main = "module Main exposing (main)

import Account exposing (Account)


plain : { title : String, size : Int } -> String
plain { title } =
    title


named : Account -> String
named { title } =
    title


main : String
main =
    plain { title = \"a\", size = 1 } ++ named { title = \"b\", owner = \"c\" }
";
        let project = Project::new(&[("Account.elm", ACCOUNT), ("Main.elm", main)]);
        let changed = project.rename("Account.elm", "title", "heading").unwrap();
        let main = text_of(&changed, "Main.elm");
        assert!(main.contains("plain { title } =\n    title"), "{main}");
        assert!(main.contains("named { heading } =\n    heading"), "{main}");
        assert!(
            main.contains("plain { title = \"a\", size = 1 } ++ named { heading = \"b\""),
            "{main}"
        );
    }

    #[test]
    fn a_record_built_from_a_pattern_without_an_alias_keeps_the_pattern() {
        let notice = "module Notice exposing (Notice, fromPayload)


type alias Notice =
    { title : String
    , action : String
    }


fromPayload : { title : String, action : String } -> Notice
fromPayload { title, action } =
    { title = title
    , action = action
    }
";
        let project = Project::new(&[("Notice.elm", notice)]);
        let changed = project.rename("Notice.elm", "action", "verb").unwrap();
        let notice = text_of(&changed, "Notice.elm");
        assert!(
            notice.contains("{ title : String, action : String } -> Notice"),
            "{notice}"
        );
        assert!(
            notice.contains("fromPayload { title, action } ="),
            "{notice}"
        );
        assert!(notice.contains(", verb = action"), "{notice}");
    }

    #[test]
    fn a_generic_function_that_two_aliases_pass_through_is_refused() {
        let other = "module Other exposing (Other)


type alias Other =
    { title : String
    }
";
        let main = "module Main exposing (main)

import Account exposing (Account)
import Other exposing (Other)


titleOf : { a | title : String } -> String
titleOf record =
    record.title


main : Account -> Other -> String
main account other =
    titleOf account ++ titleOf other
";
        let project = Project::new(&[
            ("Account.elm", ACCOUNT),
            ("Other.elm", other),
            ("Main.elm", main),
        ]);
        let refusal = project
            .rename("Account.elm", "title", "heading")
            .unwrap_err();
        assert!(refusal.contains("not possible"), "{refusal}");
        assert!(refusal.contains("Other.Other"), "{refusal}");
    }

    #[test]
    fn a_generic_function_that_one_alias_passes_through_is_renamed_with_it() {
        let main = "module Main exposing (main)

import Account exposing (Account)


titleOf : { a | title : String } -> String
titleOf record =
    record.title


main : Account -> String
main account =
    titleOf account
";
        let project = Project::new(&[("Account.elm", ACCOUNT), ("Main.elm", main)]);
        let changed = project.rename("Account.elm", "title", "heading").unwrap();
        let main = text_of(&changed, "Main.elm");
        assert!(main.contains("{ a | heading : String }"), "{main}");
        assert!(main.contains("record.heading"), "{main}");
    }

    #[test]
    fn a_record_that_a_package_declares_is_refused() {
        let page = "module Page exposing (Page, view)

import Browser


type alias Page =
    { title : String
    }


view : Page -> Browser.Document msg
view page =
    { title = page.title, body = [] }


asPage : Browser.Document msg -> Page
asPage document =
    document
";
        let project = Project::new(&[("Page.elm", page)]);
        let refusal = project.rename("Page.elm", "title", "heading").unwrap_err();
        assert!(refusal.contains("Browser.Internal.Page"), "{refusal}");
    }

    #[test]
    fn a_use_in_code_that_cannot_be_typed_is_refused_with_its_place() {
        let main = "module Main exposing (main)

import Account exposing (Account)
import Unknown


main : Account -> String
main account =
    (Unknown.get account).title
";
        let project = Project::new(&[("Account.elm", ACCOUNT), ("Main.elm", main)]);
        let refusal = project
            .rename("Account.elm", "title", "heading")
            .unwrap_err();
        assert!(refusal.contains("not possible"), "{refusal}");
        assert!(refusal.contains("Main.elm:9:"), "{refusal}");
    }

    #[test]
    fn uses_across_three_modules_through_qualified_names_and_aliases() {
        let store = "module Data.Store exposing (Store, empty, accounts)

import Account exposing (Account)


type alias Store =
    { items : List Account
    }


empty : Store
empty =
    { items = [] }


accounts : Store -> List Account
accounts store =
    store.items
";
        let main = "port module Main exposing (main)

import Account
import Data.Store as S


port send : String -> Cmd msg


titles : S.Store -> List String
titles store =
    S.accounts store
        |> List.filter (\\a -> a.owner == \"me\")
        |> List.map .title


first : S.Store -> String
first store =
    case S.accounts store of
        { title } :: _ ->
            title

        [] ->
            \"\"


nested : { inner : { account : Account.Account } } -> String
nested record =
    record.inner.account.title


main : String
main =
    first S.empty
";
        let project = Project::new(&[
            ("Account.elm", ACCOUNT),
            ("Data/Store.elm", store),
            ("Main.elm", main),
        ]);
        let changed = project.rename("Account.elm", "title", "heading").unwrap();
        let main = text_of(&changed, "Main.elm");
        assert!(main.contains("List.map .heading"), "{main}");
        assert!(
            main.contains("{ heading } :: _ ->\n            heading"),
            "{main}"
        );
        assert!(main.contains("record.inner.account.heading"), "{main}");
    }

    #[test]
    fn a_let_function_used_on_two_aliases_keeps_them_apart() {
        let other = "module Other exposing (Other)


type alias Other =
    { title : String
    }
";
        let main = "module Main exposing (main)

import Account exposing (Account)
import Other exposing (Other)


main : Account -> Other -> ( Account, Other )
main account other =
    let
        same x =
            x
    in
    ( same account, same other )


show : Other -> String
show other =
    other.title
";
        let project = Project::new(&[
            ("Account.elm", ACCOUNT),
            ("Other.elm", other),
            ("Main.elm", main),
        ]);
        let changed = project.rename("Account.elm", "title", "heading").unwrap();
        assert!(changed
            .iter()
            .all(|(path, _)| path != "Main.elm" && path != "Other.elm"));
    }

    #[test]
    fn an_alias_takes_the_place_of_the_module_name_as_qualifier() {
        // `Pile` here is the alias of Shelf. The module Pile answers to `Heap` only.
        let pile = "module Pile exposing (Pile(..), toList)


type Pile k v
    = Pile (List ( k, v ))


toList : Pile k v -> List ( k, v )
toList (Pile items) =
    items
";
        let shelf = "module Shelf exposing (Shelf(..), toList)


type Shelf k v
    = Shelf (List ( k, v ))
    | Bare


toList : Shelf k v -> List ( k, v )
toList shelf =
    case shelf of
        Shelf items ->
            items

        Bare ->
            []
";
        let main = "module Main exposing (Item, Store, firstTitles, isBare, titles)

import Pile as Heap
import Shelf as Pile


type alias Item =
    { title : String }


type alias Store =
    { items : Pile.Shelf Int Item }


titles : Store -> List String
titles store =
    Pile.toList store.items |> List.map (\\( _, item ) -> item.title)


firstTitles : Pile.Shelf Int { title : String } -> List String
firstTitles shelf =
    List.map (\\( _, entry ) -> entry.title) (Pile.toList shelf)


isBare : Store -> Bool
isBare store =
    case store.items of
        Pile.Bare ->
            True

        Pile.Shelf _ ->
            False
";
        let project = Project::new(&[("Pile.elm", pile), ("Shelf.elm", shelf), ("Main.elm", main)]);
        let changed = project
            .rename("Main.elm", "title : String }", "heading")
            .unwrap();
        let main = text_of(&changed, "Main.elm");
        assert!(main.contains("{ heading : String }"), "{main}");
        assert!(main.contains("item.heading"), "{main}");
        assert!(
            main.contains("entry.title"),
            "another record keeps its field:\n{main}"
        );
    }

    #[test]
    fn an_alias_of_a_custom_type_leaves_its_name_to_the_variant_imported() {
        // Only a record alias is a constructor, so `Ticket "x"` is the variant of Tickets
        let tickets = "module Tickets exposing (Ticket(..))


type Ticket
    = Ticket String
";
        let main = "module Main exposing (Request, make)

import Tickets exposing (Ticket(..))


type alias Ticket =
    Tickets.Ticket


type alias Request =
    { ticket : Ticket
    , title : String
    }


make title =
    { ticket = Ticket \"x\", title = title }


label request =
    request.title
";
        let project = Project::new(&[("Tickets.elm", tickets), ("Main.elm", main)]);
        let changed = project
            .rename("Main.elm", "title : String", "heading")
            .unwrap();
        let main = text_of(&changed, "Main.elm");
        assert!(main.contains("heading : String"), "{main}");
    }

    #[test]
    fn a_new_name_that_the_record_has_already_is_refused() {
        let project = Project::new(&[("Account.elm", ACCOUNT)]);
        let refusal = project.rename("Account.elm", "title", "owner").unwrap_err();
        assert!(refusal.contains("already"), "{refusal}");
    }

    /// Uses of `title` of Account in every shape the rename covers, beside an
    /// alias Other whose field has the same name
    const SHAPES: &str = "module Main exposing (main)

import Account as Acc exposing (Account, Holder(..), Login)
import Other exposing (Other)


chained : Login -> String
chained login =
    login.account.title


caseBranch : Holder -> String
caseBranch holder =
    case holder of
        Holds account ->
            account.title

        Nobody ->
            \"\"


lambda : List Account -> List String
lambda accounts =
    List.map (\\account -> account.title) accounts


accessor : List Acc.Account -> List String
accessor accounts =
    List.map .title accounts


lambdaPattern : List Account -> List String
lambdaPattern accounts =
    List.map (\\{ title } -> title) accounts


letBound : Login -> String
letBound login =
    let
        account =
            login.account
    in
    account.title


updated : Account -> Account
updated account =
    { account | title = \"x\" }


otherTitle : Other -> String
otherTitle other =
    other.title


main : String
main =
    chained { account = { title = \"Savings\", owner = \"Ada\" }, token = \"\" }
";

    const OTHER: &str = "module Other exposing (Other)


type alias Other =
    { title : String
    , size : Int
    }
";

    #[test]
    fn references_of_a_field_are_the_places_that_its_rename_changes() {
        let project = Project::new(&[
            ("Account.elm", ACCOUNT),
            ("Other.elm", OTHER),
            ("Main.elm", SHAPES),
        ]);
        let from_alias = project.references("Account.elm", "title").unwrap();
        assert_eq!(from_alias, project.renamed_places("Account.elm", "title"));
        // The field, chained, case, lambda, accessor, pattern and its variable, let, update, literal
        assert_eq!(from_alias.len(), 10, "{from_alias:?}");
        assert!(from_alias
            .iter()
            .all(|place| !place.starts_with("Other.elm")));
        assert!(
            !from_alias.contains(&"Main.elm:53:11".to_string()),
            "{from_alias:?}"
        );
        // From a use, the same places
        assert_eq!(
            project
                .references("Main.elm", "title\n\n\ncaseBranch")
                .unwrap(),
            from_alias
        );
        let other = project.references("Other.elm", "title").unwrap();
        assert_eq!(other, vec!["Main.elm:53:11", "Other.elm:5:7"]);
    }

    #[test]
    fn references_follow_the_values_into_every_record_they_pass_through() {
        let main = "module Main exposing (main)

import Account exposing (Account)
import Other exposing (Other)


titleOf : { a | title : String } -> String
titleOf record =
    record.title


main : Account -> Other -> String
main account other =
    titleOf account ++ titleOf other
";
        let project = Project::new(&[
            ("Account.elm", ACCOUNT),
            ("Other.elm", OTHER),
            ("Main.elm", main),
        ]);
        let found = project.references("Account.elm", "title").unwrap();
        assert_eq!(
            found,
            vec![
                "Account.elm:5:7",
                "Main.elm:7:17",
                "Main.elm:9:12",
                "Other.elm:5:7"
            ]
        );
    }

    #[test]
    fn references_where_code_cannot_be_typed_say_so_with_the_place() {
        let main = "module Main exposing (main)

import Account exposing (Account)
import Unknown


main : Account -> String
main account =
    (Unknown.get account).title
";
        let project = Project::new(&[("Account.elm", ACCOUNT), ("Main.elm", main)]);
        let refusal = project.references("Account.elm", "title").unwrap_err();
        assert!(refusal.contains("cannot list the uses"), "{refusal}");
        assert!(refusal.contains("Main.elm:9:"), "{refusal}");
    }

    #[test]
    fn a_removal_takes_the_fields_and_the_variables_that_patterns_bind() {
        let project = Project::new(&[
            ("Account.elm", ACCOUNT),
            ("Other.elm", OTHER),
            ("Main.elm", SHAPES),
        ]);
        let removal = project.removal("Account.elm", "title").unwrap();
        let mut all = places(&removal.fields);
        all.extend(places(&removal.bound));
        all.sort();
        let mut renamed = project.renamed_places("Account.elm", "title");
        renamed.sort();
        assert_eq!(all, renamed);
        assert_eq!(places(&removal.bound), vec!["Main.elm:34:29"]);
    }

    #[test]
    fn a_removal_from_an_alias_that_is_called_as_a_constructor_is_refused() {
        let main = "module Main exposing (main)

import Account exposing (Account)


main : Account
main =
    Account.Account \"Savings\" \"Ada\"
";
        let project = Project::new(&[("Account.elm", ACCOUNT), ("Main.elm", main)]);
        let refusal = project.removal("Account.elm", "title").unwrap_err();
        assert!(
            refusal.contains("Removing the field `title` is not possible"),
            "{refusal}"
        );
        assert!(
            refusal.contains("constructor at /project/src/Main.elm:8:5"),
            "{refusal}"
        );
    }

    #[test]
    fn a_removal_from_records_that_values_pass_through_together_is_refused() {
        let main = "module Main exposing (main)

import Account exposing (Account)
import Other exposing (Other)


titleOf : { a | title : String } -> String
titleOf record =
    record.title


main : Account -> Other -> String
main account other =
    titleOf account ++ titleOf other
";
        let project = Project::new(&[
            ("Account.elm", ACCOUNT),
            ("Other.elm", OTHER),
            ("Main.elm", main),
        ]);
        let refusal = project.removal("Account.elm", "title").unwrap_err();
        assert!(refusal.contains("Other.Other"), "{refusal}");
    }
}
