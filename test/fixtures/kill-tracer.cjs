'use strict';
// DIAGNOSTIC (T-MACOS-SIGKILL-PROBE): load with NODE_OPTIONS=--require=<this file>.
// Appends JSON lines to $KILL_TRACE_DIR/<pid>.jsonl for every process.kill call,
// every child spawned (with pgid when knowable), and every spawn/exec of kill/pkill.
// No-op when KILL_TRACE_DIR is unset. Never throws into the host process.
const fs = require('node:fs');
const path = require('node:path');
const cp = require('node:child_process');

const DIR = process.env.KILL_TRACE_DIR;
if (DIR && !global.__killTracerInstalled) {
  global.__killTracerInstalled = true;
  const file = path.join(DIR, `${process.pid}.jsonl`);
  const write = (rec) => {
    try {
      fs.mkdirSync(DIR, { recursive: true });
      fs.appendFileSync(file, JSON.stringify({ ts: Date.now(), pid: process.pid, ppid: process.ppid, ...rec }) + '\n');
    } catch { /* tracing must never break the host */ }
  };
  const stack = () => (new Error().stack || '').split('\n').slice(2, 14).join('\n');
  write({ type: 'start', argv: process.argv });

  const origKill = process.kill;
  process.kill = function tracedKill(target, signal) {
    write({ type: 'kill', target, signal: signal === undefined ? 'SIGTERM' : signal, stack: stack() });
    return origKill.apply(this, arguments);
  };

  // child.kill() goes through the process handle, not process.kill: trace it too.
  const origChildKill = cp.ChildProcess.prototype.kill;
  cp.ChildProcess.prototype.kill = function tracedChildKill(signal) {
    write({ type: 'kill', via: 'ChildProcess.kill', target: this.pid, signal: signal === undefined ? 'SIGTERM' : signal, stack: stack() });
    return origChildKill.apply(this, arguments);
  };

  const isKillCmd = (cmd) => /(^|\/|\s)(kill|pkill|killall)(\s|$)/.test(String(cmd || ''));
  const argsOf = (a) => (Array.isArray(a) ? a.map(String) : []);
  const optsOf = (args) => args.find((x) => x && typeof x === 'object' && !Array.isArray(x)) || {};

  const note = (name, cmd, args, opts, child) => {
    const rec = { type: 'spawn', via: name, command: String(cmd), args, detached: !!opts.detached, stack: stack() };
    if (child && child.pid) {
      rec.childPid = child.pid;
      // A detached child leads its own process group; otherwise it inherits ours.
      rec.pgid = opts.detached ? child.pid : null;
    }
    if (isKillCmd(cmd) || (isKillCmd(args[0]) && /sh$/.test(String(cmd)))) {
      rec.type = 'kill-cmd';
      rec.target = args.filter((x) => /^-?\d+$/.test(x)).map(Number);
      rec.signal = (args.find((x) => /^-[A-Z]/.test(x)) || '-TERM').slice(1);
    }
    if (/sh$/.test(String(cmd)) && args.some((x) => / ?(kill|pkill)\s/.test(x))) rec.type = 'kill-cmd';
    write(rec);
  };

  for (const name of ['spawn', 'execFile', 'exec', 'fork']) {
    const orig = cp[name];
    cp[name] = function traced(cmd, ...rest) {
      const child = orig.call(this, cmd, ...rest);
      try {
        const args = name === 'exec' ? [] : argsOf(rest[0]);
        note(name, name === 'fork' ? process.execPath : cmd, name === 'fork' ? [String(cmd), ...args] : args, optsOf(rest), child);
      } catch { /* ignore */ }
      return child;
    };
  }
  for (const name of ['spawnSync', 'execFileSync', 'execSync']) {
    const orig = cp[name];
    cp[name] = function traced(cmd, ...rest) {
      try { note(name, cmd, name === 'execSync' ? [] : argsOf(rest[0]), optsOf(rest), null); } catch { /* ignore */ }
      return orig.call(this, cmd, ...rest);
    };
  }
  // Propagate the patches to ESM `import { spawn } from 'node:child_process'`.
  try { require('node:module').syncBuiltinESMExports(); } catch { /* ignore */ }
}
