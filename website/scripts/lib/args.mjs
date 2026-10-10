// Tiny argv parser shared by the check scripts (node: built-ins only).
export function parseArgs(argv, { flags = [], options = [] } = {}) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (flags.includes(a)) out[a.slice(2)] = true;
    else if (options.includes(a)) {
      const v = argv[++i];
      if (v === undefined) throw new Error(`${a} needs a value`);
      out[a.slice(2)] = v;
    } else if (a.startsWith('--')) throw new Error(`unknown option ${a}`);
    else out._.push(a);
  }
  return out;
}

export function fail(lines) {
  for (const l of lines) console.error(l);
  process.exit(1);
}
