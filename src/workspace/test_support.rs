//! Projects on disk for the tests of the refactorings, and the text that
//! their edits leave.

use std::collections::HashMap;
use std::fs;
use tempfile::TempDir;
use tower_lsp::lsp_types::{TextEdit, Url};

use super::Workspace;

/// A project with these files below src, read into a workspace
pub(super) fn project(files: &[(&str, &str)]) -> (TempDir, Workspace) {
    let dir = TempDir::new().unwrap();
    fs::write(
        dir.path().join("elm.json"),
        r#"{ "source-directories": ["src"] }"#,
    )
    .unwrap();
    for (path, content) in files {
        let path = dir.path().join("src").join(path);
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(path, content).unwrap();
    }
    let mut workspace = Workspace::new(dir.path().to_path_buf());
    workspace.initialize().unwrap();
    (dir, workspace)
}

/// The URI of a file below src
pub(super) fn uri_of(dir: &TempDir, path: &str) -> Url {
    Url::from_file_path(dir.path().join("src").join(path)).unwrap()
}

/// The text of a file below src with the edits applied as the MCP server
/// applies them: from the last position to the first, and of two edits at
/// one position the later one in the list first. Columns count bytes.
pub(super) fn edited(dir: &TempDir, changes: &HashMap<Url, Vec<TextEdit>>, path: &str) -> String {
    let mut text = fs::read_to_string(dir.path().join("src").join(path)).unwrap();
    let line_starts: Vec<usize> = std::iter::once(0)
        .chain(text.match_indices('\n').map(|(at, _)| at + 1))
        .collect();
    let offset = |line: u32, character: u32| line_starts[line as usize] + character as usize;
    let mut edits = changes.get(&uri_of(dir, path)).cloned().unwrap_or_default();
    edits
        .sort_by_key(|edit| std::cmp::Reverse((edit.range.start.line, edit.range.start.character)));
    for edit in edits {
        text.replace_range(
            offset(edit.range.start.line, edit.range.start.character)
                ..offset(edit.range.end.line, edit.range.end.character),
            &edit.new_text,
        );
    }
    text
}
