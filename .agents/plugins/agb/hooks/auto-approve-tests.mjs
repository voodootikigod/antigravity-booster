import { Buffer } from 'node:buffer';
import { fileURLToPath } from 'node:url';

export function handlePreToolUse(payload) {
  let data;
  try {
    data = typeof payload === 'string' ? JSON.parse(payload) : payload;
  } catch (e) {
    return { decision: 'ask', reason: `Failed to parse hook payload: ${e.message}` };
  }

  const toolCall = data?.toolCall;
  if (toolCall?.name === 'run_command') {
    const cmdLine = String(toolCall.args?.CommandLine || '').trim();
    // Strict command line parsing and validation:
    // 1. Block shell metacharacters and comment symbols to prevent chaining/expansion/comments.
    const hasMetachars = /[;&|<>`$"'()#]/.test(cmdLine) || cmdLine.includes('\n');

    if (!hasMetachars) {
      const args = cmdLine.split(/\s+/);
      if (args[0] === 'node') {
        const hasTest = args.includes('--test');
        const allowedFlags = new Set(['node', '--test', '--coverage', '--experimental-test-coverage']);
        let allAllowed = true;
        for (const arg of args) {
          if (arg.startsWith('-')) {
            if (!allowedFlags.has(arg)) {
              allAllowed = false;
              break;
            }
          }
        }
        if (hasTest && allAllowed) {
          return {
            decision: 'allow',
            reason: `Auto-approved test command: ${cmdLine}`
          };
        }
      }
    }


  }

  // Fallback: ask the user for permission
  return { decision: 'ask' };
}

// Stdio wrapper for when executed directly via node
if (process.argv[1] === import.meta.filename || process.argv[1] === fileURLToPath(import.meta.url)) {
  (async () => {
    try {
      const chunks = [];
      for await (const chunk of process.stdin) {
        chunks.push(chunk);
      }
      const raw = Buffer.concat(chunks).toString('utf8');
      const result = handlePreToolUse(raw);
      process.stdout.write(JSON.stringify(result) + '\n');
      process.exit(0);
    } catch (err) {
      process.stdout.write(JSON.stringify({ decision: 'ask', reason: `Hook error: ${err.message}` }) + '\n');
      process.exit(0);
    }
  })();
}
