#!/usr/bin/env node
import { readdirSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawn } from 'node:child_process';
import os from 'node:os';

const rawArgs = process.argv.slice(2);
let isCoverage = false;
let isCoverageCheck = false;
let concurrency = Math.max(1, Math.min(4, os.cpus().length || 4));
const positionalArgs = [];

for (let i = 0; i < rawArgs.length; i++) {
  const arg = rawArgs[i];
  if (arg === '--coverage') {
    isCoverage = true;
  } else if (arg === '--coverage-check') {
    isCoverage = true;
    isCoverageCheck = true;
  } else if (arg.startsWith('--concurrency=')) {
    concurrency = parseInt(arg.split('=')[1], 10) || concurrency;
  } else if (arg === '--concurrency' || arg === '-c') {
    concurrency = parseInt(rawArgs[++i], 10) || concurrency;
  } else if (!arg.startsWith('-')) {
    positionalArgs.push(arg);
  }
}

const allTestFiles = readdirSync('test')
  .filter((f) => f.endsWith('.test.mjs'))
  .sort()
  .map((f) => join('test', f));

let testFiles = [];
if (positionalArgs.length) {
  for (const pos of positionalArgs) {
    if (pos.includes('*')) {
      const pattern = new RegExp('^' + pos.replace(/\./g, '\\.').replace(/\*/g, '.*') + '$');
      const matches = allTestFiles.filter((f) => pattern.test(f));
      testFiles.push(...matches);
    } else {
      testFiles.push(pos);
    }
  }
  testFiles = Array.from(new Set(testFiles));
} else {
  testFiles = allTestFiles;
}

const loaderPath = resolve('bin/loader.mjs');
const extraNodeArgs = existsSync(loaderPath)
  ? ['--loader', pathToFileURL(loaderPath).href, '--no-warnings']
  : [];
const COVERAGE_FILTERS = [
  '--test-coverage-include=lib/**',
  '--test-coverage-include=bin/**',
  '--test-coverage-include=hooks/**',
  '--test-coverage-include=mcp/**',
  '--test-coverage-include=sidecars/**',
  '--test-coverage-include=scripts/**',
  '--test-coverage-exclude=test/**',
  '--test-coverage-exclude=skills/**',
  '--test-coverage-exclude=vendor/**',
  '--test-coverage-exclude=dist/**',
  '--test-coverage-exclude=**/node_modules/**',
];
if (isCoverageCheck) {
  extraNodeArgs.push(
    '--experimental-test-coverage',
    ...COVERAGE_FILTERS,
    '--test-coverage-lines=84',
    '--test-coverage-branches=75',
    '--test-coverage-functions=86'
  );
} else if (isCoverage) {
  extraNodeArgs.push(
    '--experimental-test-coverage',
    ...COVERAGE_FILTERS
  );
}

if (isCoverage) {
  const code = await new Promise((resolvePromise) => {
    const child = spawn(
      process.execPath,
      [...extraNodeArgs, '--test', `--test-concurrency=${concurrency}`, ...testFiles],
      {
        stdio: 'inherit',
        env: { ...process.env, NODE_ENV: process.env.NODE_ENV || 'test' },
      }
    );
    child.on('close', (exitCode) => resolvePromise(exitCode ?? 1));
    child.on('error', (err) => {
      process.stderr.write(`\ncoverage runner spawn error: ${err.message}\n`);
      resolvePromise(1);
    });
  });
  process.exit(code);
}

let totalTests = 0;
let totalPass = 0;
let totalFail = 0;
let totalCancelled = 0;
let hasFailures = false;

let index = 0;

function runFile(file) {
  return new Promise((resolvePromise) => {
    const child = spawn(process.execPath, [...extraNodeArgs, '--test', file], {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, NODE_ENV: process.env.NODE_ENV || 'test' },
    });

    let stdout = '';
    let stderr = '';

    child.stdout.on('data', (d) => {
      stdout += d;
    });

    child.stderr.on('data', (d) => {
      stderr += d;
    });

    child.on('close', (code) => {
      const tests = Number((stdout.match(/^[ \t]*(?:ℹ|#)[ \t]+tests[ \t]+(\d+)/m) || [])[1] || 0);
      const pass = Number((stdout.match(/^[ \t]*(?:ℹ|#)[ \t]+pass[ \t]+(\d+)/m) || [])[1] || 0);
      const fail = Number((stdout.match(/^[ \t]*(?:ℹ|#)[ \t]+fail[ \t]+(\d+)/m) || [])[1] || 0);
      const cancelled = Number((stdout.match(/^[ \t]*(?:ℹ|#)[ \t]+cancelled[ \t]+(\d+)/m) || [])[1] || 0);

      totalTests += tests;
      totalPass += pass;
      totalFail += fail;
      totalCancelled += cancelled;

      if (code !== 0 || fail > 0) {
        hasFailures = true;
        process.stderr.write(`\n✖ ${file} failed (exit ${code}):\n`);
        if (stdout) process.stderr.write(stdout);
        if (stderr) process.stderr.write(stderr);
      } else {
        process.stdout.write(`✔ ${file} (${tests} tests)\n`);
      }
      resolvePromise();
    });

    child.on('error', (err) => {
      hasFailures = true;
      process.stderr.write(`\n✖ ${file} spawn error: ${err.message}\n`);
      resolvePromise();
    });
  });
}

async function worker() {
  while (index < testFiles.length) {
    const file = testFiles[index++];
    await runFile(file);
  }
}

const serialTests = testFiles.filter((f) => f.endsWith('evals.test.mjs'));
testFiles = testFiles.filter((f) => !f.endsWith('evals.test.mjs'));

const workers = Array.from({ length: concurrency }, () => worker());
await Promise.all(workers);

for (const file of serialTests) {
  await runFile(file);
}

console.log(`\nℹ tests ${totalTests}`);
console.log(`ℹ pass ${totalPass}`);
console.log(`ℹ fail ${totalFail}`);
console.log(`ℹ cancelled ${totalCancelled}`);
console.log(`# tests ${totalTests}`);
console.log(`# pass ${totalPass}`);
console.log(`# fail ${totalFail}`);
console.log(`# cancelled ${totalCancelled}`);

process.exit(hasFailures ? 1 : 0);
