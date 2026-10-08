// Closed tool taxonomy and probed argument schemas for the PreToolUse policy
// guard (spec .adlc/specs/native-plugin-installation.md §4.5.1, Appendix A).
// Tool names are agy 1.2.16 CORTEX_STEP_TYPE_* names, lowercased.

export const READ_ONLY_TOOLS = new Set([
  'view_file', 'grep_search', 'code_search', 'list_directory',
  'read_url_content', 'read_browser_page', 'search_web',
  'list_resources', 'read_resource', 'ask_question',
  'view_file_outline', 'read_terminal', 'read_notebook', 'command_status',
]);

export const ORCHESTRATION_TOOLS = new Set([
  'invoke_subagent', 'define_subagent', 'manage_subagents', 'schedule', 'send_message',
]);

// agy control steps with no filesystem, shell or network effect. `finish`
// (CORTEX_STEP_TYPE_FINISH) ends the turn and, under --json-schema, carries the
// model's structured answer; its args are answer text, never paths, so they are
// not path-scanned. Verified against agy 1.3.1 (no file/attachment fields on
// FinishToolConfig); re-check on agy upgrades. Add a step here only with
// evidence it has no side effect.
export const AGY_CONTROL_TOOLS = new Set(['finish']);

export const BOOSTER_MCP_SERVER = 'agb';
export const BOOSTER_MCP_TOOLS = new Set([
  'agb_plan', 'agb_run', 'agb_preflight', 'agb_status', 'agb_doctor', 'agb_review',
]);

export const PATH_MUTATING_TOOLS = new Set([
  'run_command', 'write_to_file', 'replace_file_content', 'multi_replace_file_content',
  'edit_file', 'create_file', 'save_file', 'delete_file', 'move', 'delete_directory',
  'edit_notebook', 'write_blob',
]);

// Step 1 inspection: which argument keys carry a path for read tools.
export const READ_TOOL_PATH_SCHEMAS = {
  view_file: ['AbsolutePath', 'filePath', 'path'],
  view_file_outline: ['AbsolutePath', 'filePath', 'path'],
  read_notebook: ['AbsolutePath', 'notebookPath', 'path'],
  read_resource: ['Uri', 'uri'],
  read_browser_page: ['Url', 'url'],
  read_url_content: ['Url', 'url'],
  list_directory: ['DirAbsolutePath', 'DirectoryPath', 'path', 'dir'],
  grep_search: ['SearchPath', 'DirectoryPath', 'path'],
  code_search: ['SearchPath', 'DirectoryPath', 'path'],
  file_search: ['SearchPath', 'DirectoryPath', 'path'],
};

// Gate 1: required path keys for file-mutating tools (probed agy 1.2.16).
export const TOOL_PATH_SCHEMAS = {
  write_to_file: { required: ['TargetFile'] },
  replace_file_content: { required: ['TargetFile'] },
  multi_replace_file_content: { required: ['TargetFile'] },
  edit_file: { required: ['TargetFile'] },
  create_file: { required: ['TargetFile'] },
  save_file: { required: ['TargetFile'] },
  delete_file: { required: ['TargetFile'] },
  move: { required: ['source', 'destination'] },
  delete_directory: { required: ['directoryPath'] },
  edit_notebook: { required: ['notebookPath'] },
  write_blob: { required: ['targetPath'] },
};

// Free-text / non-path keys never inspected as paths (Appendix A E5).
export const EXCLUDED_CONTENT_KEYS = new Set([
  'TargetContent', 'ReplacementContent', 'CodeContent', 'Content',
  'Instruction', 'Description', 'summary', 'prompt', 'code', 'text',
  'explanation', 'message', 'comment',
  'toolAction', 'toolSummary', 'WaitMsBeforeAsync',
]);

// Appendix A D1: standing implicit rails (trust-root set), repo-relative.
// Directory entries freeze everything beneath them.
export const IMPLICIT_RAIL_DIRS = ['.git', '.adlc/ticket-archive', '.adlc/ticket-transactions', '.adlc/leases'];
export const IMPLICIT_RAIL_FILES = ['.adlc/config.json', '.adlc/manifest.jsonl', '.adlc/sessions.json', '.adlc/tickets.json'];
export const TICKET_STORE_DIR = '.adlc/tickets';

// Appendix A.6 item 5: verbs for which `.`/`..`/repo-root tokens are destructive.
export const DESTRUCTIVE_ROOT_VERBS = new Set(['rm', 'mv']);

// Shell Stage 1: pure readers (argv[0] exactly, no write redirection).
export const PURE_READERS = new Set(['cat', 'head', 'tail', 'grep', 'ls', 'wc']);
