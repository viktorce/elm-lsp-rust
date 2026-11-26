/**
 * The two conditions that are compared, the same in every harness. They
 * differ in one thing only, whether the session has the language server. The
 * server hands it its MCP tools and a few notes on how to call them.
 */

import { dirname, join } from "path";
import { fileURLToPath } from "url";
import { findHarness, installAt, SERVER_NAME } from "../../mcp-wrapper/harnesses.mjs";

export const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

// The language server as a user registers it, plus --project-tools: the codebases are the operator's
// own, and the server must use the compiler each of them pins, the same one the check command runs.
// Every harness that the benchmark runs starts the same command, so Claude Code's entry stands for all.
function languageServer() {
  const { command, args } = findHarness("claude-code").config(installAt(REPO_ROOT)).mcpServers[SERVER_NAME];
  return { [SERVER_NAME]: { command, args: [...args, "--project-tools"] } };
}

export const ARMS = {
  baseline: { title: "Without language server", mcpServers: {} },
  lsp: { title: "With language server", mcpServers: languageServer() },
};
