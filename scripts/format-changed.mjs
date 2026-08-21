#!/usr/bin/env node

import { spawnSync } from 'node:child_process';

const FORMATTABLE_EXTENSIONS = new Set([
  '.ts',
  '.tsx',
  '.js',
  '.jsx',
  '.json',
  '.md',
  '.yml',
  '.yaml',
  '.sql',
]);

const changedFiles = readChangedFiles();
const formattableFiles = changedFiles.filter(isFormattable);

if (formattableFiles.length === 0) {
  console.log('format:changed — no formattable files changed.');
  process.exit(0);
}

const result = spawnSync('npx', ['dprint', 'fmt', ...formattableFiles], { stdio: 'inherit' });
process.exit(result.status ?? 1);

function readChangedFiles() {
  const diffed = runGit(['diff', '--name-only', '--diff-filter=ACMR', 'HEAD']);
  const untracked = runGit(['ls-files', '--others', '--exclude-standard']);
  return [...new Set([...toLines(diffed), ...toLines(untracked)])];
}

function isFormattable(file) {
  const dotIndex = file.lastIndexOf('.');
  if (dotIndex === -1) {
    return false;
  }
  return FORMATTABLE_EXTENSIONS.has(file.slice(dotIndex));
}

function toLines(output) {
  return output.split('\n').filter((line) => line.length > 0);
}

function runGit(args) {
  const result = spawnSync('git', args, { encoding: 'utf8' });
  if (result.status !== 0) {
    throw new Error(result.stderr.trim() || `git ${args.join(' ')} failed`);
  }
  return result.stdout;
}
