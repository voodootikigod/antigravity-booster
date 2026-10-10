import { readFileSync } from 'node:fs';
import path from 'node:path';

/** Root package.json version, read as JSON at build time (not a module import). */
export function getReleaseVersion(): string {
  const file = path.join(process.cwd(), '..', 'package.json');
  const pkg = JSON.parse(readFileSync(file, 'utf8')) as { version?: unknown };
  if (typeof pkg.version !== 'string') {
    throw new Error(`${file}: missing string "version"`);
  }
  return pkg.version;
}
