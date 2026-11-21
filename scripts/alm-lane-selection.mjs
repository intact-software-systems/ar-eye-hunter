#!/usr/bin/env node

import { appendFileSync } from 'node:fs';
import { parseArgs } from 'node:util';

import { resolveAlmFullScopeSelection } from './alm-lane-selection/resolve-alm-full-scope-selection.mjs';
import { readChangedPathsBetweenRevisions, readMergeBase } from './repository-changes/read-git-changes.mjs';

try {
    const { values } = parseArgs({
        options: { base: { type: 'string', default: '' }, head: { type: 'string', default: '' } },
        strict: true
    });
    const repoRoot = process.cwd();
    // From the merge base, so a branch behind its base is not charged with what the base changed since.
    const mergeBase = readMergeBase(repoRoot, values.base, values.head);
    const changedPaths = readChangedPathsBetweenRevisions(repoRoot, mergeBase, values.head)
        .flatMap((change) => change.oldPath === undefined ? [change.path] : [change.oldPath, change.path]);
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
}
catch (error) {
    console.error(`FAIL: ALM lane selection: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
}
