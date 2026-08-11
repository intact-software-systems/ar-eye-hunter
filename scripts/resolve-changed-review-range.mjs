#!/usr/bin/env node

import { execFileSync } from 'node:child_process';

const [trustedBaseRef, candidateRef] = process.argv.slice(2);
if (!trustedBaseRef || !candidateRef) {
  console.error('usage: resolve-changed-review-range.mjs <trusted-base-ref> <candidate-ref>');
  process.exit(1);
}

const trustedBaseTip = resolveCommit(trustedBaseRef, 'trusted base');
const candidateHead = resolveCommit(candidateRef, 'candidate head');
const mergeBase = runGit(['merge-base', trustedBaseTip, candidateHead]).trim();

console.log(`trusted_base_tip=${trustedBaseTip}`);
console.log(`base=${mergeBase}`);
console.log(`head=${candidateHead}`);

function resolveCommit(ref, label) {
  try {
    return runGit(['rev-parse', '--verify', `${ref}^{commit}`]).trim();
  } catch {
    console.error(`FAIL: cannot resolve ${label}: ${ref}`);
    process.exit(1);
  }
}

function runGit(args) {
  return execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}
