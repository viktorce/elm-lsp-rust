//! Types for workspace operations.
//!
//! Contains result types for move, rename, and removal operations.

use std::collections::HashMap;
use tower_lsp::lsp_types::{Range, TextEdit, Url};

use crate::type_checker::FieldDefinition;

// ============================================================================
// Basic Info Types
// ============================================================================

/// Information about a field at a position
#[derive(Debug, Clone)]
pub struct FieldInfo {
    pub name: String,
    pub range: Range,
    pub definition: FieldDefinition,
}

/// Result of a file rename/move operation
#[derive(Debug)]
pub struct FileOperationResult {
    pub old_module_name: String,
    pub new_module_name: String,
    pub old_path: String,
    pub new_path: String,
    pub files_updated: usize,
    pub changes: HashMap<Url, Vec<TextEdit>>,
}

// ============================================================================
// Variant Removal Types
// ============================================================================

/// Entry in a call chain showing how a function is called
#[derive(Debug, Clone, serde::Serialize)]
pub struct CallChainEntry {
    pub function: String,
    pub file: String,
    pub module_name: String,
    pub line: u32,
    pub is_entry_point: bool,
}

/// Type of variant usage - determines if it blocks removal
#[derive(Debug, Clone, PartialEq, serde::Serialize)]
pub enum UsageType {
    /// Constructor call like `let x = Blue` - BLOCKING
    Constructor,
    /// Pattern match like `Blue -> ...` - can be auto-removed
    PatternMatch,
    /// Type signature like `foo : Color -> ...` - not blocking, skip
    TypeSignature,
    /// Definition of the variant itself - skip
    Definition,
    /// Inside a string literal like `"MarkTicketAsResolved"` - skip
    StringLiteral,
}

/// Information about a variant usage
#[derive(Debug, Clone, serde::Serialize)]
pub struct VariantUsage {
    pub uri: String,
    pub line: u32,
    pub character: u32,
    pub is_blocking: bool,
    pub context: String,
    pub function_name: Option<String>,
    pub module_name: String,
    pub call_chain: Vec<CallChainEntry>,
    pub usage_type: UsageType,
    /// Full range of the pattern branch (for auto-removal)
    #[serde(skip_serializing_if = "Option::is_none")]
    pub pattern_branch_range: Option<Range>,
    /// Full range of the constructor expression (for Debug.todo replacement)
    #[serde(skip_serializing_if = "Option::is_none")]
    pub constructor_usage_range: Option<Range>,
}

/// Result of a remove variant operation
#[derive(Debug, serde::Serialize)]
pub struct RemoveVariantResult {
    pub success: bool,
    pub message: String,
    pub blocking_usages: Vec<VariantUsage>,
    pub changes: Option<HashMap<Url, Vec<TextEdit>>>,
}

impl RemoveVariantResult {
    pub fn error(message: &str) -> Self {
        Self {
            success: false,
            message: message.to_string(),
            blocking_usages: Vec::new(),
            changes: None,
        }
    }

    pub fn success(message: &str, changes: HashMap<Url, Vec<TextEdit>>) -> Self {
        Self {
            success: true,
            message: message.to_string(),
            blocking_usages: Vec::new(),
            changes: Some(changes),
        }
    }
}

// ============================================================================
// Variant Addition Types
// ============================================================================

/// Information about a case expression that needs a new branch
#[derive(Debug, Clone, serde::Serialize)]
pub struct CaseExpressionInfo {
    pub uri: String,
    pub line: u32,
    pub character: u32,
    pub context: String,
    pub module_name: String,
    pub has_wildcard: bool,
    /// Range where to insert the new branch
    #[serde(skip_serializing_if = "Option::is_none")]
    pub insert_range: Option<Range>,
    /// The indentation to use for the new branch
    pub indentation: String,
    /// The patterns of the branches that the case needs, none where a
    /// catch-all takes the new variant already
    pub patterns: Vec<BranchPattern>,
}

/// The pattern of a new branch, written around the new variant. In a case
/// on a tuple it is "( Help, _ )", and in a case on a Maybe "Just Help".
#[derive(Debug, Clone, PartialEq, serde::Serialize)]
pub struct BranchPattern {
    /// What stands before the variant
    pub before: String,
    /// The qualifier that the other branches write the variants with, or none
    pub qualifier: Option<String>,
    /// What stands after the variant
    pub after: String,
    /// Whether the variant is the argument of another one, where it needs
    /// brackets once it takes arguments of its own
    pub in_argument: bool,
}

impl BranchPattern {
    /// The pattern with the variant in it, and a wildcard for each of its arguments
    pub fn with(&self, variant: &str, arity: usize) -> String {
        let qualified = match &self.qualifier {
            Some(qualifier) => format!("{}.{}", qualifier, variant),
            None => variant.to_string(),
        };
        let applied = format!("{}{}", qualified, " _".repeat(arity));
        let written = if self.in_argument && arity > 0 {
            format!("({})", applied)
        } else {
            applied
        };
        format!("{}{}{}", self.before, written, self.after)
    }
}

/// Result of preparing to add a variant
#[derive(Debug, serde::Serialize)]
pub struct PrepareAddVariantResult {
    pub success: bool,
    pub message: String,
    pub type_name: String,
    pub variant_name: String,
    pub existing_variants: Vec<String>,
    pub case_expressions: Vec<CaseExpressionInfo>,
    pub cases_needing_branch: usize,
    /// Each place where the compiler would ask for a branch that this tool
    /// cannot write, with its module, line and code. elm_add_variant changes
    /// nothing while there is one.
    pub unhandled: Vec<String>,
}

impl PrepareAddVariantResult {
    pub fn error(message: &str) -> Self {
        Self {
            success: false,
            message: message.to_string(),
            type_name: String::new(),
            variant_name: String::new(),
            existing_variants: Vec::new(),
            case_expressions: Vec::new(),
            cases_needing_branch: 0,
            unhandled: Vec::new(),
        }
    }
}

/// Configuration for a single branch when adding a variant.
///
/// JSON format examples:
/// - `"AddDebug"` → inserts Debug.todo
/// - `{"AddCode": "LightTheme"}` → inserts custom code
/// - `{"AddCodeWithImports": {"imports": ["Module"], "code": "expr"}}` → code + imports
#[derive(Debug, Clone, serde::Deserialize, serde::Serialize)]
#[serde(untagged)]
pub enum BranchConfig {
    /// Use Debug.todo for this branch
    Debug(DebugVariant),
    /// Custom code expression
    Code(CodeVariant),
    /// Custom code with imports
    CodeWithImports(CodeWithImportsVariant),
}

#[derive(Debug, Clone, serde::Deserialize, serde::Serialize)]
pub enum DebugVariant {
    AddDebug,
}

#[derive(Debug, Clone, serde::Deserialize, serde::Serialize)]
pub enum CodeVariant {
    AddCode(String),
}

#[derive(Debug, Clone, serde::Deserialize, serde::Serialize)]
pub enum CodeWithImportsVariant {
    AddCodeWithImports { imports: Vec<String>, code: String },
}

impl BranchConfig {
    /// Get the code expression, or None for Debug.todo
    pub fn code(&self) -> Option<&str> {
        match self {
            BranchConfig::Debug(_) => None,
            BranchConfig::Code(CodeVariant::AddCode(code)) => Some(code),
            BranchConfig::CodeWithImports(CodeWithImportsVariant::AddCodeWithImports {
                code,
                ..
            }) => Some(code),
        }
    }

    /// Get imports if any
    pub fn imports(&self) -> &[String] {
        match self {
            BranchConfig::Debug(_) => &[],
            BranchConfig::Code(_) => &[],
            BranchConfig::CodeWithImports(CodeWithImportsVariant::AddCodeWithImports {
                imports,
                ..
            }) => imports,
        }
    }
}

/// Result of adding a variant
#[derive(Debug, serde::Serialize)]
pub struct AddVariantResult {
    pub success: bool,
    pub message: String,
    pub changes: Option<HashMap<Url, Vec<TextEdit>>>,
    /// When there's an error about too many branch_codes, include the prepare info
    /// so the caller knows exactly how many are needed
    #[serde(skip_serializing_if = "Option::is_none")]
    pub prepare_info: Option<PrepareAddVariantResult>,
}

impl AddVariantResult {
    pub fn error(message: &str) -> Self {
        Self {
            success: false,
            message: message.to_string(),
            changes: None,
            prepare_info: None,
        }
    }

    pub fn error_with_info(message: &str, prep: PrepareAddVariantResult) -> Self {
        Self {
            success: false,
            message: message.to_string(),
            changes: None,
            prepare_info: Some(prep),
        }
    }

    pub fn success(message: &str, changes: HashMap<Url, Vec<TextEdit>>) -> Self {
        Self {
            success: true,
            message: message.to_string(),
            changes: Some(changes),
            prepare_info: None,
        }
    }
}

// ============================================================================
// Field Removal Types
// ============================================================================

/// Type of field usage for removal classification
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, serde::Serialize)]
pub enum FieldUsageType {
    /// Field in type definition: { name : String }
    Definition,
    /// Field in record literal: { name = "value" }
    RecordLiteral,
    /// Field access: user.name
    FieldAccess,
    /// Field accessor function: .name
    FieldAccessor,
    /// Field in record pattern: { name }
    RecordPattern,
    /// Field in record update: { user | name = x }
    RecordUpdate,
    /// A use of the variable that a record pattern binds: { name } -> name
    PatternVariable,
}

/// Information about a field usage
#[derive(Debug, Clone, serde::Serialize)]
pub struct FieldUsage {
    pub uri: String,
    pub line: u32,
    pub character: u32,
    pub usage_type: FieldUsageType,
    pub context: String,
    pub module_name: String,
    /// Full range for the field (for removal)
    #[serde(skip_serializing_if = "Option::is_none")]
    pub full_range: Option<Range>,
    /// Custom replacement text (if None, use default behavior)
    #[serde(skip_serializing_if = "Option::is_none")]
    pub replacement_text: Option<String>,
}

/// Result of a remove field operation
#[derive(Debug, serde::Serialize)]
pub struct RemoveFieldResult {
    pub success: bool,
    pub message: String,
    pub changes: Option<HashMap<Url, Vec<TextEdit>>>,
}

impl RemoveFieldResult {
    pub fn error(message: &str) -> Self {
        Self {
            success: false,
            message: message.to_string(),
            changes: None,
        }
    }

    pub fn success(message: &str, changes: HashMap<Url, Vec<TextEdit>>) -> Self {
        Self {
            success: true,
            message: message.to_string(),
            changes: Some(changes),
        }
    }
}
