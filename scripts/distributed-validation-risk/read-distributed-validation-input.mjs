import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

import { decodeGitChangedPathRecords } from './distributed-validation-risk.mjs';

export function readChangedPathRecords(repoRoot, base, head) {
  const rawRecords = execFileSync(
    'git',
    ['diff', '--name-status', '-z', '--find-renames', '--find-copies', base, head, '--'],
    { cwd: repoRoot, encoding: 'utf8' },
  );
  return decodeGitChangedPathRecords(rawRecords);
}

export function readAdaptivePlanDocuments(repoRoot) {
  const plansRoot = path.join(repoRoot, 'plans');
  let entries;
  try {
    entries = readdirSync(plansRoot, { withFileTypes: true });
  } catch (error) {
    if (toError(error).code === 'ENOENT') {
      return [];
    }
    throw error;
  }

  return entries
    .filter((entry) => entry.isFile() && entry.name.endsWith('.md') && entry.name !== 'README.md')
    .sort((left, right) => left.name.localeCompare(right.name))
    .map((entry) => ({
      path: `plans/${entry.name}`,
      markdown: readFileSync(path.join(plansRoot, entry.name), 'utf8'),
    }))
    .filter((document) => document.markdown.includes('```plan-adaptation-v1'));
}

function toError(value) {
  return value instanceof Error ? value : new Error(String(value));
}
