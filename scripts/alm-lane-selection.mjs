#!/usr/bin/env node

import {
    appendFileSync,
    readFileSync
} from 'node:fs';

import { resolveAlmFullScopeSelection } from './alm-lane-selection/resolve-alm-full-scope-selection.mjs';

const changedPaths = readFileSync(process.stdin.fd, 'utf8')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
const selection = resolveAlmFullScopeSelection(changedPaths);

const githubOutputPath = process.env.GITHUB_OUTPUT;
if (githubOutputPath !== undefined && githubOutputPath.length > 0) {
    appendFileSync(githubOutputPath, `run_full_scope=${String(selection.runFullScope)}\n`, 'utf8');
}
console.log(
    selection.runFullScope
        ? `SELECTED: full ALM scope for ${selection.decidingPaths.join(', ')}`
        : 'SKIPPED: every changed path cannot change the ALM lane'
);
