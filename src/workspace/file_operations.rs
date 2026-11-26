//! File operations for the Elm workspace.
//!
//! Contains functions for renaming and moving Elm files, updating module
//! declarations and imports across the workspace.

use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use tower_lsp::lsp_types::*;

use super::{
    composed, is_module_segment, is_same_file, normalized, FileOperationResult, Workspace,
    LAMDERA_PROTECTED_FILES,
};
use crate::parser::ElmParser;

/// Check if a file is a protected Lamdera file (must be at root of src/)
fn is_lamdera_protected_file(path: &Path) -> bool {
    if let Some(file_name) = path.file_name().and_then(|n| n.to_str()) {
        if LAMDERA_PROTECTED_FILES.contains(&file_name) {
            // Check if parent directory is "src" (the file is at root of src/)
            if let Some(parent) = path.parent() {
                if let Some(parent_name) = parent.file_name().and_then(|n| n.to_str()) {
                    return parent_name == "src";
                }
            }
        }
    }
    false
}

/// `path` with each part that the disk does not hold yet in the form a
/// module's name has, every accent written as one letter. A file system that
/// tells the two forms of an accent apart keeps a name as it is given, and
/// the compiler looks for a module under the one form. A part that is there
/// already stays as the caller spells it.
fn with_new_names_composed(path: &Path) -> PathBuf {
    let mut made = PathBuf::new();
    for part in path.components() {
        let given = made.join(part);
        made = if given.symlink_metadata().is_ok() {
            given
        } else {
            made.join(composed(&part.as_os_str().to_string_lossy()))
        };
    }
    made
}

impl Workspace {
    /// Rename a file and update its module declaration + all imports
    pub fn rename_file(&self, uri: &Url, new_name: &str) -> anyhow::Result<FileOperationResult> {
        let old_path = uri
            .to_file_path()
            .map_err(|_| anyhow::anyhow!("Invalid file URI"))?;

        // Block renaming protected Lamdera files (only at root of src/)
        if self.is_lamdera_project && is_lamdera_protected_file(&old_path) {
            if let Some(file_name) = old_path.file_name().and_then(|n| n.to_str()) {
                return Err(anyhow::anyhow!(
                    "Cannot rename {} in a Lamdera project - this file is required by Lamdera",
                    file_name
                ));
            }
        }

        // Validate new name
        if !new_name.ends_with(".elm") {
            return Err(anyhow::anyhow!("New name must end with .elm"));
        }

        // Get old module name from file content
        let content = std::fs::read_to_string(&old_path)?;
        let old_module_name = extract_module_name_from_content(&content)
            .ok_or_else(|| anyhow::anyhow!("Could not extract module name from file"))?;

        // Compute new module name (just the filename without .elm)
        // Only the one ending: "Text.elm.elm" is no name of a module
        let new_module_base = composed(new_name.strip_suffix(".elm").unwrap_or(new_name));
        if !is_module_segment(&new_module_base) {
            return Err(anyhow::anyhow!(
                "\"{}\" is no module name. It has to start with an upper-case letter and hold only letters, digits and underscores",
                new_module_base
            ));
        }

        // Compute new path
        let new_path = with_new_names_composed(
            &old_path
                .parent()
                .ok_or_else(|| anyhow::anyhow!("Invalid file path"))?
                .join(new_name),
        );

        // The compiler finds a module by its path below a source directory, so that
        // path is the module's name, whatever the file declared so far: a copy in
        // src/Backup that still says "module Utils" becomes Backup.Helpers. A file
        // that lies where its name says stays in its directory and keeps the first
        // parts of the name. With "src" and "src/Sub" in elm.json, Sub.Utils in
        // src/Sub becomes Sub.Helpers, where the inner directory alone would call
        // it Helpers. A file in no source directory keeps the first parts of the
        // name it declares too.
        let keeps_its_place =
            self.is_at_home(&old_path, &old_module_name) || !self.is_in_source_directory(&new_path);
        let new_module_name = if keeps_its_place {
            match old_module_name.rsplit_once('.') {
                Some((prefix, _)) => format!("{}.{}", prefix, new_module_base),
                None => new_module_base.to_string(),
            }
        } else {
            self.module_name_at(&new_path)?
        };

        // Collect all edits
        let mut changes: HashMap<Url, Vec<TextEdit>> = HashMap::new();

        // 1. Update module declaration in the file itself
        if let Some(name_range) = find_module_name_range(&content) {
            changes.entry(uri.clone()).or_default().push(TextEdit {
                range: name_range,
                new_text: new_module_name.clone(),
            });
        }

        // 2. Update all imports across the workspace
        let files_updated = self.update_imports_of_file(
            &old_path,
            &old_module_name,
            &new_module_name,
            uri,
            &mut changes,
        )?;
        self.update_exposed_modules(&old_module_name, &new_module_name, &mut changes)?;

        Ok(FileOperationResult {
            old_module_name,
            new_module_name,
            old_path: old_path.to_string_lossy().to_string(),
            new_path: new_path.to_string_lossy().to_string(),
            files_updated,
            changes,
        })
    }

    /// Move a file to a new location and update its module declaration + all imports
    pub fn move_file(&self, uri: &Url, target_path: &str) -> anyhow::Result<FileOperationResult> {
        let old_path = uri
            .to_file_path()
            .map_err(|_| anyhow::anyhow!("Invalid file URI"))?;

        // Block moving protected Lamdera files (only at root of src/)
        if self.is_lamdera_project && is_lamdera_protected_file(&old_path) {
            if let Some(file_name) = old_path.file_name().and_then(|n| n.to_str()) {
                return Err(anyhow::anyhow!(
                    "Cannot move {} in a Lamdera project - this file is required by Lamdera",
                    file_name
                ));
            }
        }

        // Validate target path
        if !target_path.ends_with(".elm") {
            return Err(anyhow::anyhow!("Target path must end with .elm"));
        }

        // Get old module name from file content
        let content = std::fs::read_to_string(&old_path)?;
        let old_module_name = extract_module_name_from_content(&content)
            .ok_or_else(|| anyhow::anyhow!("Could not extract module name from file"))?;

        // The full new path. A relative target starts at the workspace root.
        let new_path =
            with_new_names_composed(&normalized(&if Path::new(target_path).is_absolute() {
                PathBuf::from(target_path)
            } else {
                self.root_path.join(target_path)
            }));

        // The compiler finds a module by its path below a source directory,
        // so that path is the module's name
        let new_module_name = self.module_name_at(&new_path)?;

        // Collect all edits
        let mut changes: HashMap<Url, Vec<TextEdit>> = HashMap::new();

        // 1. Update module declaration in the file itself
        if let Some(name_range) = find_module_name_range(&content) {
            changes.entry(uri.clone()).or_default().push(TextEdit {
                range: name_range,
                new_text: new_module_name.clone(),
            });
        }

        // 2. Update all imports across the workspace
        let files_updated = self.update_imports_of_file(
            &old_path,
            &old_module_name,
            &new_module_name,
            uri,
            &mut changes,
        )?;
        self.update_exposed_modules(&old_module_name, &new_module_name, &mut changes)?;

        Ok(FileOperationResult {
            old_module_name,
            new_module_name,
            old_path: old_path.to_string_lossy().to_string(),
            new_path: new_path.to_string_lossy().to_string(),
            files_updated,
            changes,
        })
    }

    /// Update the imports of the module in the file at `path`, when that file
    /// is the one the module's importers mean. A copy that still declares the
    /// module of the file it was made from waits for that name, and nothing
    /// imports it: the importers of the name are the other file's.
    fn update_imports_of_file(
        &self,
        path: &Path,
        old_module: &str,
        new_module: &str,
        skip_uri: &Url,
        changes: &mut HashMap<Url, Vec<TextEdit>>,
    ) -> anyhow::Result<usize> {
        let holds_the_name = self
            .modules
            .get(old_module)
            .is_some_and(|module| is_same_file(&module.path, path));
        if !holds_the_name {
            return Ok(0);
        }
        self.update_imports_for_rename(old_module, new_module, skip_uri, changes)
    }

    /// Update all imports of old_module to new_module across the workspace
    fn update_imports_for_rename(
        &self,
        old_module: &str,
        new_module: &str,
        skip_uri: &Url,
        changes: &mut HashMap<Url, Vec<TextEdit>>,
    ) -> anyhow::Result<usize> {
        let mut files_updated = 0;
        // What the renamed module exposes, read where a file needs it
        let mut exposed: Option<HashSet<String>> = None;

        for module in self.modules.values() {
            let file_uri =
                Url::from_file_path(&module.path).map_err(|_| anyhow::anyhow!("Invalid path"))?;

            // Skip Evergreen files
            if module.path.to_string_lossy().contains("/Evergreen/") {
                continue;
            }

            // Skip the file being renamed/moved (already handled)
            if &file_uri == skip_uri {
                continue;
            }

            let content = std::fs::read_to_string(&module.path)?;
            // A file that never writes the name neither imports the module nor uses it
            if !content.contains(old_module) {
                continue;
            }
            let Some(tree) = self.parser.parse(&content) else {
                continue;
            };
            let header = header_clauses(&tree);

            // Find all import statements for the old module
            let imports: Vec<(tree_sitter::Node, tree_sitter::Node)> = header
                .iter()
                .filter_map(|(clause, name)| Some((*clause, (*name)?)))
                .filter(|(clause, name)| {
                    clause.kind() == "import_clause" && &content[name.byte_range()] == old_module
                })
                .collect();
            for (_, name) in &imports {
                changes.entry(file_uri.clone()).or_default().push(TextEdit {
                    range: self.parser.node_to_range(*name),
                    new_text: new_module.to_string(),
                });
                files_updated += 1;
            }

            // "Utils.greet" means the renamed module only in a file that imports it
            // under its own name. With "import Utils as U" the file says "U.greet",
            // and in a file without the import "Utils" is the alias of another module.
            let imports_it_by_name = imports
                .iter()
                .any(|(clause, _)| clause.child_by_field_name("asClause").is_none());
            if !imports_it_by_name {
                continue;
            }

            // "Utils.greet" can also mean another module that the file imports
            // under the alias Utils. Elm then looks the name up in both, so it
            // means the renamed module only where that module exposes it.
            let shares_its_qualifier = header.iter().any(|(clause, name)| {
                clause.kind() == "import_clause"
                    && import_alias(*clause, &content) == Some(old_module)
                    && !name.is_some_and(|name| &content[name.byte_range()] == old_module)
            });
            if shares_its_qualifier && exposed.is_none() {
                exposed = Some(self.names_exposed_by(old_module)?);
            }

            // The uses come from the parse tree, so a string or a comment that
            // spells the name is left as it is
            for (qid, qualifier, member) in qualified_names(&tree, &content) {
                if qualifier != old_module {
                    continue;
                }
                if shares_its_qualifier
                    && !exposed.as_ref().is_some_and(|names| names.contains(member))
                {
                    continue;
                }
                let start = qid.start_position();
                changes.entry(file_uri.clone()).or_default().push(TextEdit {
                    range: Range {
                        start: Position {
                            line: start.row as u32,
                            character: start.column as u32,
                        },
                        end: Position {
                            line: start.row as u32,
                            character: (start.column + old_module.len()) as u32,
                        },
                    },
                    new_text: new_module.to_string(),
                });
            }
        }

        Ok(files_updated)
    }

    /// A package lists the modules it exposes in its elm.json, and the
    /// renamed module keeps its place there under its new name. A build of
    /// one file does not read that list, so the compiler would not tell.
    fn update_exposed_modules(
        &self,
        old_module: &str,
        new_module: &str,
        changes: &mut HashMap<Url, Vec<TextEdit>>,
    ) -> anyhow::Result<()> {
        let path = self.root_path.join("elm.json");
        let Ok(content) = std::fs::read_to_string(&path) else {
            return Ok(());
        };
        let entries = exposed_module_entries(&content, old_module);
        if entries.is_empty() {
            return Ok(());
        }
        let uri = Url::from_file_path(&path).map_err(|_| anyhow::anyhow!("Invalid path"))?;
        let new_text = serde_json::to_string(new_module)?;
        changes
            .entry(uri)
            .or_default()
            .extend(entries.into_iter().map(|range| TextEdit {
                range,
                new_text: new_text.clone(),
            }));
        Ok(())
    }

    /// The names that the module of this name lets its importers qualify
    fn names_exposed_by(&self, module_name: &str) -> anyhow::Result<HashSet<String>> {
        let Some(module) = self.modules.get(module_name) else {
            return Ok(HashSet::new());
        };
        let content = std::fs::read_to_string(&module.path)?;
        Ok(self
            .parser
            .parse(&content)
            .map(|tree| exposed_names(&tree, &content))
            .unwrap_or_default())
    }
}

/// The places in the text of an elm.json where its `exposed-modules` names
/// the module, each with the quotes around the name. A package lists the
/// modules it exposes there, as one list or as lists under titles. A title
/// is no module, and nothing outside of that entry is either.
fn exposed_module_entries(content: &str, module: &str) -> Vec<Range> {
    // A file that is no JSON could be read in more than one way
    let lists_modules = serde_json::from_str::<serde_json::Value>(content)
        .is_ok_and(|json| json.get("exposed-modules").is_some());
    if !lists_modules {
        return Vec::new();
    }
    let mut found = Vec::new();
    // The open brackets and braces around the place the scan is at
    let mut open: Vec<u8> = Vec::new();
    // Whether the next string of an object at this depth is a key
    let mut awaits_key = false;
    // The depth of `exposed-modules`' value while the scan is in it
    let mut within: Option<usize> = None;
    let mut last_key_at_top: Option<String> = None;
    let bytes = content.as_bytes();
    let mut at = 0;
    while at < bytes.len() {
        match bytes[at] {
            b'{' | b'[' => {
                if open.len() == 1 && last_key_at_top.as_deref() == Some("exposed-modules") {
                    within = Some(open.len());
                }
                open.push(bytes[at]);
                awaits_key = bytes[at] == b'{';
            }
            b'}' | b']' => {
                open.pop();
                if within.is_some_and(|depth| open.len() == depth) {
                    within = None;
                }
            }
            b',' => awaits_key = open.last() == Some(&b'{'),
            b':' => awaits_key = false,
            b'"' => {
                let start = at;
                at += 1;
                while at < bytes.len() && bytes[at] != b'"' {
                    at += if bytes[at] == b'\\' { 2 } else { 1 };
                }
                let end = (at + 1).min(bytes.len());
                let text = &content[start..end];
                let value: Option<String> = serde_json::from_str(text).ok();
                if awaits_key {
                    if open.len() == 1 {
                        last_key_at_top = value;
                    }
                } else if within.is_some()
                    && open.last() == Some(&b'[')
                    && value.as_deref() == Some(module)
                {
                    found.push(Range {
                        start: position_of(content, start),
                        end: position_of(content, end),
                    });
                }
            }
            _ => {}
        }
        at += 1;
    }
    found
}

/// The line and the column of a byte of the text. Columns count bytes.
fn position_of(content: &str, offset: usize) -> Position {
    let before = &content[..offset];
    let line = before.matches('\n').count();
    let column = offset - before.rfind('\n').map_or(0, |at| at + 1);
    Position::new(line as u32, column as u32)
}

/// The module declaration and the imports at the top of a file, each with
/// the name of the module in it. They come from the parse tree, so a clause
/// counts however it is laid out: with any number of spaces, with "exposing"
/// on a line of its own. A line in a comment or in a string that reads like
/// one does not count. Where the parser could not read a clause to its end
/// the name is left out, because what it took for the name can be a part of
/// it.
fn header_clauses(
    tree: &tree_sitter::Tree,
) -> Vec<(tree_sitter::Node<'_>, Option<tree_sitter::Node<'_>>)> {
    let root = tree.root_node();
    let mut cursor = root.walk();
    root.children(&mut cursor)
        .filter(|clause| matches!(clause.kind(), "module_declaration" | "import_clause"))
        .map(|clause| {
            let mut parts = clause.walk();
            let name = clause
                .children(&mut parts)
                .find(|part| part.kind() == "upper_case_qid")
                .filter(|_| !clause.has_error());
            (clause, name)
        })
        .collect()
}

/// The name of the module that a file declares, and the place of the name
/// in the file. Columns count bytes.
fn declared_name(content: &str) -> Option<(String, Range)> {
    let parser = ElmParser::new();
    let tree = parser.parse(content)?;
    let name = header_clauses(&tree)
        .into_iter()
        .find_map(|(clause, name)| name.filter(|_| clause.kind() == "module_declaration"))?;
    Some((
        content[name.byte_range()].to_string(),
        parser.node_to_range(name),
    ))
}

/// The name of the module that a file declares, read from its text
pub(crate) fn extract_module_name_from_content(content: &str) -> Option<String> {
    declared_name(content).map(|(name, _)| name)
}

/// The place of the module's name in the file that declares it
pub(crate) fn find_module_name_range(content: &str) -> Option<Range> {
    declared_name(content).map(|(_, place)| place)
}

/// The alias that an import gives its module, as in "import Theme.Palette as Colors"
fn import_alias<'a>(clause: tree_sitter::Node, content: &'a str) -> Option<&'a str> {
    let name = clause
        .child_by_field_name("asClause")?
        .child_by_field_name("name")?;
    Some(&content[name.byte_range()])
}

/// Every qualified name in the code below the header, with its qualifier and
/// the name behind it: "Utils.Extra.pad" gives "Utils.Extra" and "pad", and
/// "Utils.Color" gives "Utils" and "Color". A value names its qualifier with
/// all its upper-case parts, a type or a variant with all but the last.
fn qualified_names<'t, 's>(
    tree: &'t tree_sitter::Tree,
    content: &'s str,
) -> Vec<(tree_sitter::Node<'t>, &'s str, &'s str)> {
    let mut found = Vec::new();
    let mut pending = vec![tree.root_node()];
    while let Some(node) = pending.pop() {
        match node.kind() {
            "module_declaration" | "import_clause" => continue,
            "value_qid" | "upper_case_qid" => {
                let mut cursor = node.walk();
                let parts: Vec<_> = node
                    .children(&mut cursor)
                    .filter(|part| part.kind() != "dot")
                    .collect();
                if let [first, .., qualifier_end, member] = parts.as_slice() {
                    found.push((
                        node,
                        &content[first.start_byte()..qualifier_end.end_byte()],
                        &content[member.byte_range()],
                    ));
                } else if let [first, member] = parts.as_slice() {
                    found.push((
                        node,
                        &content[first.byte_range()],
                        &content[member.byte_range()],
                    ));
                }
                continue;
            }
            _ => {}
        }
        let mut cursor = node.walk();
        pending.extend(node.children(&mut cursor));
    }
    found
}

/// The first child of a node that is of the kind
pub(super) fn child_of_kind<'t>(
    node: tree_sitter::Node<'t>,
    kind: &str,
) -> Option<tree_sitter::Node<'t>> {
    let mut cursor = node.walk();
    let found = node
        .children(&mut cursor)
        .find(|child| child.kind() == kind);
    found
}

/// The values, types and variants that a module exposes. A record alias is
/// a constructor too, and the name of the alias covers both.
fn exposed_names(tree: &tree_sitter::Tree, content: &str) -> HashSet<String> {
    let root = tree.root_node();
    let text = |node: tree_sitter::Node| content[node.byte_range()].to_string();
    // Each declaration with the names it brings, the first of them its own
    let mut declared: Vec<Vec<String>> = Vec::new();
    let mut cursor = root.walk();
    for declaration in root.children(&mut cursor) {
        let names = match declaration.kind() {
            "value_declaration" => child_of_kind(declaration, "function_declaration_left")
                .and_then(|left| left.child(0))
                .map(|name| vec![text(name)]),
            "port_annotation" => {
                child_of_kind(declaration, "lower_case_identifier").map(|name| vec![text(name)])
            }
            "type_alias_declaration" => {
                child_of_kind(declaration, "upper_case_identifier").map(|name| vec![text(name)])
            }
            "type_declaration" => child_of_kind(declaration, "upper_case_identifier").map(|name| {
                let mut variants = declaration.walk();
                std::iter::once(text(name))
                    .chain(
                        declaration
                            .children(&mut variants)
                            .filter(|child| child.kind() == "union_variant")
                            .filter_map(|variant| variant.child(0))
                            .map(text),
                    )
                    .collect()
            }),
            _ => None,
        };
        declared.extend(names);
    }

    let exposing = child_of_kind(root, "module_declaration")
        .and_then(|declaration| child_of_kind(declaration, "exposing_list"));
    let Some(exposing) = exposing else {
        return HashSet::new();
    };
    if child_of_kind(exposing, "double_dot").is_some() {
        return declared.into_iter().flatten().collect();
    }
    let mut names = HashSet::new();
    let mut items = exposing.walk();
    for item in exposing.children(&mut items) {
        match item.kind() {
            "exposed_value" => names.extend(child_of_kind(item, "lower_case_identifier").map(text)),
            "exposed_type" => {
                let Some(name) = child_of_kind(item, "upper_case_identifier").map(text) else {
                    continue;
                };
                // "Color(..)" exposes the variants along with the type
                if child_of_kind(item, "exposed_union_constructors").is_some() {
                    if let Some(type_names) = declared.iter().find(|names| names[0] == name) {
                        names.extend(type_names.iter().cloned());
                    }
                }
                names.insert(name);
            }
            _ => {}
        }
    }
    names
}

#[cfg(test)]
mod tests {
    use super::super::test_support::{edited, project, uri_of};
    use super::exposed_module_entries;
    use tower_lsp::lsp_types::{Position, Range};

    #[test]
    fn test_the_entries_of_exposed_modules_are_the_names_in_its_lists() {
        let at = |line: u32, from: u32, to: u32| Range {
            start: Position::new(line, from),
            end: Position::new(line, to),
        };
        // A title, a summary and a dependency that spell the name are no entries
        let grouped = r#"{
    "type": "package",
    "name": "author/shop",
    "summary": "Shop.Units",
    "exposed-modules": {
        "Shop.Units": [ "Shop.Units", "Shop.Units.Extra" ],
        "Caf\u00e9": ["Café", "Shop.Units"]
    },
    "dependencies": { "Shop.Units": "1.0.0 <= v < 2.0.0" }
}"#;
        assert_eq!(
            exposed_module_entries(grouped, "Shop.Units"),
            vec![at(5, 24, 36), at(6, 31, 43)]
        );
        // Columns count bytes, and an escape spells the letter it stands for
        assert_eq!(exposed_module_entries(grouped, "Café"), vec![at(6, 22, 29)]);
        let listed = "{\"type\":\"package\",\"exposed-modules\":[\"Shop.Units\"]}";
        assert_eq!(
            exposed_module_entries(listed, "Shop.Units"),
            vec![at(0, 37, 49)]
        );
        // An application exposes no modules, and a file that is no JSON is left alone
        let application = r#"{ "type": "application", "source-directories": ["Shop.Units"] }"#;
        assert_eq!(exposed_module_entries(application, "Shop.Units"), vec![]);
        let broken = r#"{ "type": "package", "exposed-modules": ["Shop.Units" }"#;
        assert_eq!(exposed_module_entries(broken, "Shop.Units"), vec![]);
    }

    const UNITS: &str = "module Shop.Units exposing (Weight(..), grams)\n\n\ntype Weight\n    = Grams Int\n\n\ngrams : Int -> Weight\ngrams =\n    Grams\n";

    const UNITS_EXTRA: &str =
        "module Shop.Units.Extra exposing (pad)\n\n\npad : String -> String\npad s =\n    s\n";

    #[test]
    fn test_a_module_rename_leaves_strings_and_comments_as_they_are() {
        let main = r#"module Main exposing (main)

import Shop.Units
import Shop.Units.Extra


{-| The name of the type as a schema spells it: Shop.Units.Weight
-}
weightType : String
weightType =
    "Shop.Units.Weight"


label : String
label =
    """
Shop.Units.grams
"""


weigh : Shop.Units.Weight -> Int
weigh weight =
    case weight of
        Shop.Units.Grams n ->
            -- Shop.Units.grams makes one
            n


main : Shop.Units.Weight
main =
    let
        make =
            \n -> Shop.Units.grams n
    in
    {- Shop.Units.grams 5 -}
    make (String.length (Shop.Units.Extra.pad " Shop.Units" ++ weightType))
"#;
        let (dir, workspace) = project(&[
            ("Shop/Units.elm", UNITS),
            ("Shop/Units/Extra.elm", UNITS_EXTRA),
            ("Main.elm", main),
        ]);
        let expected = main
            .replace("import Shop.Units\n", "import Shop.Measures\n")
            .replace("weigh : Shop.Units.Weight", "weigh : Shop.Measures.Weight")
            .replace(
                "        Shop.Units.Grams n",
                "        Shop.Measures.Grams n",
            )
            .replace("main : Shop.Units.Weight", "main : Shop.Measures.Weight")
            .replace("\\n -> Shop.Units.grams n", "\\n -> Shop.Measures.grams n");

        let renamed = workspace
            .rename_file(&uri_of(&dir, "Shop/Units.elm"), "Measures.elm")
            .unwrap();
        assert_eq!(edited(&dir, &renamed.changes, "Main.elm"), expected);

        // A move shares the code that finds the uses
        let moved = workspace
            .move_file(&uri_of(&dir, "Shop/Units.elm"), "src/Shop/Measures.elm")
            .unwrap();
        assert_eq!(edited(&dir, &moved.changes, "Main.elm"), expected);
    }

    const COLORS: &str = "module Colors exposing (Color(..), primary)\n\n\ntype Color\n    = Red\n    | Blue\n\n\nprimary : String\nprimary =\n    let\n        accent =\n            \"red\"\n    in\n    accent\n";

    const PALETTE: &str = "port module Theme.Palette exposing (Tone, accent, blue, shade)\n\n\ntype alias Tone =\n    String\n\n\naccent : String\naccent =\n    \"teal\"\n\n\nblue : Tone\nblue =\n    \"navy\"\n\n\nport shade : String -> Cmd msg\n";

    #[test]
    fn test_a_module_rename_leaves_names_of_another_import_with_the_same_alias() {
        // Colors.accent is Theme.Palette.accent: Colors keeps its own accent in a let.
        // Colors.Tone and Colors.shade are the alias's too, Colors.Blue and Colors.Color
        // are the renamed module's.
        let main = r#"module Main exposing (main)

import Colors exposing (Color)
import Theme.Palette as Colors


chosen : Colors.Tone
chosen =
    Colors.accent


pick : Colors.Color -> String
pick color =
    case color of
        Colors.Red ->
            Colors.primary

        Colors.Blue ->
            Colors.blue


main : Cmd msg
main =
    Colors.shade (chosen ++ pick Colors.Blue)
"#;
        let (dir, workspace) = project(&[
            ("Colors.elm", COLORS),
            ("Theme/Palette.elm", PALETTE),
            ("Main.elm", main),
        ]);
        let expected = main
            .replace("import Colors exposing", "import Shades exposing")
            .replace("pick : Colors.Color", "pick : Shades.Color")
            .replace("Colors.Red ->", "Shades.Red ->")
            .replace("Colors.primary", "Shades.primary")
            .replace("Colors.Blue ->", "Shades.Blue ->")
            .replace("pick Colors.Blue", "pick Shades.Blue");

        let renamed = workspace
            .rename_file(&uri_of(&dir, "Colors.elm"), "Shades.elm")
            .unwrap();
        assert_eq!(edited(&dir, &renamed.changes, "Main.elm"), expected);
    }

    #[test]
    fn test_a_module_rename_leaves_every_name_of_an_alias_that_the_module_does_not_take() {
        // Here the renamed module goes by another alias, so every "Colors." means the palette
        let main = r#"module Main exposing (main)

import Colors as Paint
import Theme.Palette as Colors


main : String
main =
    Colors.accent ++ Paint.primary
"#;
        let (dir, workspace) = project(&[
            ("Colors.elm", COLORS),
            ("Theme/Palette.elm", PALETTE),
            ("Main.elm", main),
        ]);
        let renamed = workspace
            .rename_file(&uri_of(&dir, "Colors.elm"), "Shades.elm")
            .unwrap();
        assert_eq!(
            edited(&dir, &renamed.changes, "Main.elm"),
            main.replace("import Colors as Paint", "import Shades as Paint")
        );
    }
}
