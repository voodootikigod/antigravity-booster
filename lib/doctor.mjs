import { execFile } from 'child_process';
import { promisify } from 'util';
import { readPluginContract } from './adlc-bridge.mjs';
import { resolvePluginPath } from './bootstrap.mjs';
import { existsSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';

const execFileAsync = promisify(execFile);

export async function checkNodeVersion() {
  const version = process.version;
  const major = parseInt(version.slice(1).split('.')[0], 10);
  if (major >= 18) {
    return { name: 'Node.js', level: 'pass', detail: version, fix: null };
  }
  return { name: 'Node.js', level: 'fail', detail: version, fix: 'Upgrade Node.js to v18 or newer.' };
}

export async function checkAgyBinary({ env = process.env } = {}) {
  try {
    const { stdout } = await execFileAsync(env.AGB_AGY_BIN || 'agy', ['--version'], { env, timeout: 5000 });
    let v = stdout.trim();
    if (!v.startsWith('v')) v = 'v' + v;
    return { name: 'agy CLI', level: 'pass', detail: v, fix: null };
  } catch (err) {
    return { name: 'agy CLI', level: 'fail', detail: 'not found or error', fix: 'Install Google Antigravity CLI and ensure it is on PATH.' };
  }
}

export async function checkAgyAuth({ env = process.env } = {}) {
  try {
    const { stdout } = await execFileAsync(env.AGB_AGY_BIN || 'agy', ['models'], { env, timeout: 5000 });
    if (stdout.trim().length > 0) {
      return { name: 'agy Auth', level: 'pass', detail: 'authenticated', fix: null };
    }
    return { name: 'agy Auth', level: 'fail', detail: 'no models returned', fix: 'Run `agy login` to authenticate.' };
  } catch (err) {
    return { name: 'agy Auth', level: 'fail', detail: 'error fetching models', fix: 'Run `agy login` to authenticate.' };
  }
}

export async function checkPlugin({ env = process.env } = {}) {
  try {
    const pluginPath = resolvePluginPath();
    if (!pluginPath) throw new Error('not found');
    const contract = readPluginContract(pluginPath);
    if (!contract.adlcContract) {
      return { name: 'adlc-antigravity plugin', level: 'warn', detail: 'installed (legacy version)', fix: 'Upgrade @adlc/antigravity to enable live rail enforcement.' };
    }
    if (contract.adlcContract !== 1) {
      return { name: 'adlc-antigravity plugin', level: 'fail', detail: `unsupported contract v${contract.adlcContract}`, fix: 'Install a compatible version of @adlc/antigravity.' };
    }
    return { name: 'adlc-antigravity plugin', level: 'pass', detail: 'installed and compatible', fix: null };
  } catch (err) {
    return { name: 'adlc-antigravity plugin', level: 'fail', detail: 'not found', fix: 'Run `npx agb bootstrap` to install the plugin.' };
  }
}

export async function checkAdlcBinary({ env = process.env } = {}) {
  try {
    const { stdout } = await execFileAsync(env.AGB_ADLC_BIN || 'adlc', ['--version'], { env, timeout: 5000 });
    let v = stdout.trim();
    if (!v.startsWith('v')) v = 'v' + v;
    return { name: 'adlc CLI', level: 'pass', detail: v, fix: null };
  } catch (err) {
    return { name: 'adlc CLI', level: 'warn', detail: 'not found', fix: 'adlc CLI is optional but recommended. Install it if you want local ADLC gate execution.' };
  }
}

export async function checkSandbox({ env = process.env, platform = process.platform } = {}) {
  if (env.AGB_SANDBOX_GATES === '0') {
    return { name: 'Sandbox', level: 'pass', detail: 'bypassed via env', fix: null };
  }
  if (platform === 'darwin') {
    try {
      await execFileAsync('which', ['sandbox-exec'], { env, timeout: 5000 });
      return { name: 'Sandbox', level: 'pass', detail: 'sandbox-exec available', fix: null };
    } catch (err) {
      return { name: 'Sandbox', level: 'fail', detail: 'sandbox-exec missing', fix: 'macOS sandbox-exec is missing. Set AGB_SANDBOX_GATES=0 to bypass.' };
    }
  }
  return { name: 'Sandbox', level: 'fail', detail: 'unsupported platform', fix: 'Sandbox is only supported on macOS. Set AGB_SANDBOX_GATES=0 to bypass.' };
}

export async function checkBrainDir({ env = process.env } = {}) {
  const dir = env.AGB_BRAIN_DIR || join(homedir(), '.gemini/antigravity/brain');
  if (existsSync(dir)) {
    return { name: 'Brain Dir', level: 'pass', detail: 'exists', fix: null };
  }
  return { name: 'Brain Dir', level: 'warn', detail: 'not found', fix: 'Run an agy session to initialize the brain directory.' };
}

export async function runDoctor(opts = {}) {
  const checks = [
    checkNodeVersion(),
    checkAgyBinary(opts),
    checkAgyAuth(opts),
    checkPlugin(opts),
    checkAdlcBinary(opts),
    checkSandbox(opts),
    checkBrainDir(opts)
  ];
  
  const results = await Promise.allSettled(checks);
  let failed = false;
  
  console.log('Environment Diagnostic:\n');
  console.log(String().padEnd(25) + ' | ' + String().padEnd(6) + ' | ' + String().padEnd(30) + ' | ' + 'Fix');
  console.log('-'.repeat(25) + '-+-' + '-'.repeat(6) + '-+-' + '-'.repeat(30) + '-+-' + '-'.repeat(30));
  
  for (const res of results) {
    if (res.status === 'rejected') {
      console.log(`Error check failed: ${res.reason}`);
      failed = true;
      continue;
    }
    const c = res.value;
    if (c.level === 'fail') failed = true;
    
    const levelStr = c.level === 'pass' ? 'PASS' : c.level === 'warn' ? 'WARN' : 'FAIL';
    console.log(c.name.padEnd(25) + ' | ' + levelStr.padEnd(6) + ' | ' + c.detail.padEnd(30) + ' | ' + (c.fix || ''));
  }
  console.log('');
  return failed ? 2 : 0;
}
