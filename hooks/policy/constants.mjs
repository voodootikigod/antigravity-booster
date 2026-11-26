// Closed tool taxonomy and probed argument schemas for the PreToolUse policy
// guard (spec .adlc/specs/native-plugin-installation.md §4.5.1, Appendix A).
// Tool names are agy 1.2.16 CORTEX_STEP_TYPE_* names, lowercased.

export const READ_ONLY_TOOLS = new Set([
  'view_file', 'read_file', 'grep_search', 'code_search', 'file_search', 'list_directory',
  'read_url_content', 'read_browser_page', 'search_web',
  'list_resources', 'read_resource', 'ask_question',
  'view_file_outline', 'read_terminal', 'read_notebook', 'command_status',
  'find_by_name',
  'list_dir', 'list_permissions', 'search_in_file', 'wait', 'wait_5_seconds',
]);

// CodeGraph MCP exploration tools: permitted interactively for in-workspace paths
// outside boosterDataRoots; denied in headless/read-only worker sessions unless
// AGB_ALLOW_CODEGRAPH_MCP=1.
export const CODEGRAPH_READ_TOOLS = new Set([
  'codegraph_explore',
  'mcp_codegraph_codegraph_explore',
  'mcp__codegraph__codegraph_explore',
]);

export const ORCHESTRATION_TOOLS = new Set([
  'invoke_subagent', 'define_subagent', 'manage_subagents', 'schedule', 'send_message',
  'manage_task', 'swarm',
]);

// agy 1.5.9+ dynamic Python workflow orchestrator: spawns python3 whose stdlib
// file/process calls do not fire PreToolUse hooks.
export const WORKFLOW_TOOLS = new Set(['run_workflow']);

// Top-level prose keys on `swarm` (agy 1.5.5+) and `run_workflow` (agy 1.5.9+).
export const SWARM_PROSE_KEYS = new Set(['brief', 'title', 'tasks', 'toolAction', 'toolSummary']);
export const SWARM_META_KEYS = new Set(['action', 'workspace', 'model', 'name', 'fork']);
export const SWARM_WORKSPACE_MODES = new Set(['inherit', 'share', 'branch']);
export const WORKFLOW_PROSE_KEYS = new Set(['Script', 'Description', 'toolAction', 'toolSummary']);

export const STDIN_TOOLS = new Set(['send_command_input']);
export const SUBAGENT_TOOLS = new Set(['invoke_subagent', 'define_subagent', 'manage_subagents']);
export const SUBAGENT_PROSE_KEYS = new Set([
  'Prompt', 'prompt', 'SystemPrompt', 'systemprompt',
  'Description', 'description', 'Role', 'role',
  'toolAction', 'toolaction', 'toolSummary', 'toolsummary',
]);

// agy control steps with no filesystem, shell or network effect. `finish`
// (CORTEX_STEP_TYPE_FINISH) ends the turn and, under --json-schema, carries the
// model's structured answer; its args are answer text, never paths, so they are
// not path-scanned. Verified against agy 1.3.1 (no file/attachment fields on
// FinishToolConfig); re-check on agy upgrades. Add a step here only with
// evidence it has no side effect.
export const AGY_CONTROL_TOOLS = new Set(['finish']);

export const BOOSTER_MCP_SERVER = 'agb';
export const BOOSTER_MCP_SERVERS = new Set(['agb', 'antigravity-booster_agb']);
export const BOOSTER_MCP_TOOLS = new Set([
  'agb_shape', 'agb_plan', 'agb_run', 'agb_preflight', 'agb_status', 'agb_doctor', 'agb_init', 'agb_review', 'agb_distill',
  'agb_flight_deck', 'agb_mission_control', 'agb_plan_viewer', 'agb_control', 'agb_accept', 'agb_holdout',
]);
export const READONLY_BOOSTER_CONTROL_ACTIONS = new Set(['snapshot', 'diff', 'stream']);
export const BRAIN_APPS = ['antigravity', 'antigravity-cli', 'antigravity-ide', 'jetski'];
export const DIR_READ_TOOLS = new Set([
  'list_dir', 'list_directory', 'grep_search', 'code_search', 'file_search',
  'find_by_name', 'search_in_file', 'list_permissions',
]);

export const PATH_MUTATING_TOOLS = new Set([
  'run_command', 'write_to_file', 'write_file', 'replace_file_content', 'multi_replace_file_content',
  'edit_file', 'create_file', 'save_file', 'delete_file', 'move', 'delete_directory',
  'edit_notebook', 'notebook_edit', 'write_blob',
]);

export const SED_ALLOWED_KEYS = new Set([
  'target_file', 'targetfile', 'expressions', 'file_content', 'filecontent', 'toolaction', 'toolsummary',
]);

export const NOTEBOOK_EXEC_TOOLS = new Set(['notebook_execution']);

// Step 1 inspection: which argument keys carry a path for read tools.
export const READ_TOOL_PATH_SCHEMAS = {
  view_file: ['AbsolutePath', 'filePath', 'path'],
  read_file: ['Path', 'AbsolutePath', 'filePath', 'path'],
  view_file_outline: ['AbsolutePath', 'filePath', 'path'],
  read_notebook: ['AbsolutePath', 'notebookPath', 'path'],
  read_resource: ['Uri', 'uri'],
  read_browser_page: ['Url', 'url'],
  read_url_content: ['Url', 'url'],
  list_directory: ['DirAbsolutePath', 'DirectoryPath', 'path', 'dir'],
  grep_search: ['SearchPath', 'DirectoryPath', 'path'],
  code_search: ['SearchPath', 'DirectoryPath', 'path'],
  file_search: ['SearchPath', 'DirectoryPath', 'path'],
  find_by_name: ['SearchPath', 'SearchDirectory', 'DirectoryPath', 'path', 'dir'],
  list_dir: ['DirectoryPath', 'DirAbsolutePath', 'AbsolutePath', 'path', 'dir'],
  list_permissions: ['paths', 'path'],
  search_in_file: ['paths', 'path', 'DirectoryPath', 'SearchPath'],
  codegraph_explore: ['projectPath', 'path', 'DirectoryPath'],
  mcp_codegraph_codegraph_explore: ['projectPath', 'path', 'DirectoryPath'],
  mcp__codegraph__codegraph_explore: ['projectPath', 'path', 'DirectoryPath'],
};

// Folded (lowercase) path keys of the read tools that REQUIRE a path argument.
export const REQUIRED_READ_PATH_KEYS = {
  view_file: ['absolutepath', 'filepath', 'path'],
  view_file_outline: ['absolutepath', 'filepath', 'path'],
  read_file: ['path', 'absolutepath', 'filepath'],
  read_notebook: ['notebookpath', 'absolutepath', 'path'],
  read_browser_page: ['url'],
  read_url_content: ['url'],
  list_dir: ['directorypath', 'dirabsolutepath', 'absolutepath', 'path', 'dir'],
  list_directory: ['directorypath', 'dirabsolutepath', 'absolutepath', 'path', 'dir'],
  search_in_file: ['paths', 'path', 'directorypath', 'searchpath'],
};

export const ASK_PERMISSION_ACTIONS = new Set(['command', 'read_file', 'write_file', 'read_url', 'execute_url', 'download_url', 'mcp']);
export const ASK_PERMISSION_PROSE_KEYS = new Set(['Reason', 'reason', 'toolAction', 'toolaction', 'toolSummary', 'toolsummary']);
export const GENERATE_IMAGE_PROSE_KEYS = new Set(['Prompt', 'prompt', 'toolAction', 'toolaction', 'toolSummary', 'toolsummary']);

// Gate 1: required path keys for file-mutating tools (probed agy 1.2.16).
export const TOOL_PATH_SCHEMAS = {
  write_to_file: { required: ['TargetFile'] },
  write_file: { required: ['Path'] },
  replace_file_content: { required: ['TargetFile'] },
  multi_replace_file_content: { required: ['TargetFile'] },
  edit_file: { required: ['TargetFile'], altRequired: ['Path'] },
  create_file: { required: ['TargetFile'] },
  save_file: { required: ['TargetFile'] },
  delete_file: { required: ['TargetFile'] },
  move: { required: ['source', 'destination'] },
  delete_directory: { required: ['directoryPath'] },
  edit_notebook: { required: ['notebookPath'] },
  notebook_edit: { required: ['NotebookPath'] },
  write_blob: { required: ['targetPath'] },
};

// Free-text / non-path keys never inspected as paths (Appendix A E5).
export const EXCLUDED_CONTENT_KEYS = new Set([
  'TargetContent', 'ReplacementContent', 'Target', 'Replacement', 'CodeContent', 'Content',
  'Instruction', 'Description', 'ArtifactMetadata', 'Summary', 'summary', 'prompt', 'code', 'text',
  'explanation', 'message', 'comment',
  'CellContent', 'NewSource', 'Source', 'Cells', 'CellId', 'CellID', 'EditMode', 'CellType',
  'toolAction', 'toolSummary', 'WaitMsBeforeAsync',
]);

// Appendix A D1: standing implicit rails (trust-root set), repo-relative.
// Directory entries freeze everything beneath them.
export const IMPLICIT_RAIL_DIRS = ['.git', '.adlc/ticket-archive', '.adlc/ticket-transactions', '.adlc/leases'];
export const IMPLICIT_RAIL_FILES = ['.adlc/config.json', '.adlc/manifest.jsonl', '.adlc/sessions.json', '.adlc/tickets.json', '.adlc/learned-checks.json'];
export const TICKET_STORE_DIR = '.adlc/tickets';

// Appendix A.6 item 5: verbs for which `.`/`..`/repo-root tokens are destructive.
export const DESTRUCTIVE_ROOT_VERBS = new Set(['rm', 'mv']);

// Shell Stage 1: pure readers (argv[0] exactly, no write redirection).
export const PURE_READERS = new Set(['cat', 'head', 'tail', 'grep', 'ls', 'wc']);
