#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import path from 'node:path';

import {
    boundaryUnknownMagnitude,
    compareFindingMagnitudeDescending,
    findingMagnitude,
    matchesBaseMagnitude
} from './repo-style-check/finding-magnitude.mjs';
import { navigationClassifications, scanNavigationProject } from './repo-style-check/navigation-rules.mjs';
import {
    collectProductionSources,
    isProductionCodeFile,
    isTestEnforcedFinding,
    isTestSourceFile,
    scanProductionSources
} from './repo-style-check/repository-scan.mjs';
import { isReviewedDisposition, readReviewedDispositionContext } from './repo-style-check/reviewed-dispositions.mjs';
import { readStructuralLineageMap, StructuralLineageValidationError } from './repo-style-check/structural-lineage.mjs';

const worktreeTarget = 'WORKTREE';
const [baseReference, targetReference = worktreeTarget] = process.argv.slice(2);
const scanOptions = Object.freeze({
    layoutOnly: false,
    layoutDetails: true,
    constructionDetails: false,
    outputContracts: true,
    objectInterfaces: true,
    // Gate flip: the cognitive metrics are the failing signal, with the
    // tolerance bands owned by finding-magnitude.mjs; file.length remains only
    // as the 1,200-line navigation backstop after the data-literal discount.
    cognitiveMetrics: true
});

async function main() {
    if (baseReference === undefined) {
        failUsage('A base reference is required.');
        return;
    }

    const repoRoot = runGit(['rev-parse', '--show-toplevel']).trim();
    const baseCommit = resolveCommit(baseReference, 'base');
    if (baseCommit === undefined) {
        return;
    }
    const headCommit = runGit(['rev-parse', 'HEAD']).trim();
    const targetCommit = targetReference === worktreeTarget ? headCommit : resolveCommit(targetReference, 'target');
    if (targetCommit === undefined) {
        return;
    }
    if (targetReference !== worktreeTarget && targetCommit !== headCommit) {
        failUsage('The explicit target must resolve to the currently checked-out HEAD.');
        return;
    }

    const mergeBase = runGit(['merge-base', baseCommit, targetCommit]).trim();
    const changes = readChanges(mergeBase, targetReference, repoRoot);
    const renameByTargetPath = toRenameMap(changes);
    const structuralLineageByTargetPath = readStructuralLineageMap({
        repoRoot,
        mergeBase,
        targetReference,
        targetCommit,
        renameByTargetPath
    });
    const governedTargetSources = targetReference === worktreeTarget
        ? await collectProductionSources([repoRoot], { includeTests: true })
        : readRevisionProductionSources(repoRoot, targetCommit);
    const baseSources = toBaseSources({
        repoRoot,
        mergeBase,
        targetSources: governedTargetSources,
        changes
    });
    const navigationProductChanged = changes.some((change) =>
        [change.source, change.target]
            .filter(Boolean)
            .some((file) => isNavigationProductSource(repoRoot, path.join(repoRoot, file)))
    );
    const baseFindings = [
        ...toEnforcedFindings(
            scanProductionSources({ repoRoot, sources: baseSources, options: scanOptions }).findings
        ),
        ...(navigationProductChanged ? scanHighConfidenceNavigationFindings(repoRoot, baseSources) : [])
    ];
    const targetFindings = [
        ...toEnforcedFindings(
            scanProductionSources({ repoRoot, sources: governedTargetSources, options: scanOptions })
                .findings
        ),
        ...(navigationProductChanged
            ? scanHighConfidenceNavigationFindings(repoRoot, governedTargetSources)
            : [])
    ];
    const newFindings = subtractExistingFindings({
        repoRoot,
        baseFindings,
        targetFindings,
        structuralLineageSourcePaths: new Set(structuralLineageByTargetPath.values()),
        logicalSourceByTargetPath: new Map([...renameByTargetPath, ...structuralLineageByTargetPath])
    });
    const reviewedDispositionContext = readReviewedDispositionContext(repoRoot, targetCommit);

    printChangedFindings({
        repoRoot,
        mergeBase,
        targetReference,
        newFindings: newFindings.filter(
            (finding) => !isReviewedDisposition(repoRoot, finding, reviewedDispositionContext)
        ),
        governanceIssues: reviewedDispositionContext.issues
    });
}

const isGovernedSourceFile = (file) => isProductionCodeFile(file) || isTestSourceFile(file);

// Both sides of the comparison are filtered, so a rule that is not yet enforced on tests never
// enters the base or the target set and cannot register as new or worsened.
const toEnforcedFindings = (findings) => findings.filter((entry) => isTestEnforcedFinding(entry.file, entry.ruleId));

function scanHighConfidenceNavigationFindings(repoRoot, sources) {
    const productionSources = sources.filter(({ file }) => isNavigationProductSource(repoRoot, file));
    return scanNavigationProject({ repoRoot, sources: productionSources }).findings.filter(
        (finding) => finding.classification === navigationClassifications.highConfidenceFinding
    );
}

function isNavigationProductSource(repoRoot, file) {
    const relativeFile = toRelativePath(repoRoot, file);
    return isProductionCodeFile(file) &&
        (relativeFile.startsWith('apps/') || relativeFile.startsWith('packages/'));
}

function printChangedFindings(result) {
    for (const issue of result.governanceIssues) {
        console.log(`FAIL: governance decision receipt: ${issue}`);
    }
    if (result.newFindings.length === 0 && result.governanceIssues.length === 0) {
        console.log(
            `PASS: no new repository style findings ` +
                `(${result.mergeBase} -> ${result.targetReference}).`
        );
        return;
    }

    if (result.newFindings.length > 0) {
        console.log(
            `FAIL: ${result.newFindings.length} new or worsened repository style finding` +
                `${result.newFindings.length === 1 ? '' : 's'} ` +
                `(${result.mergeBase} -> ${result.targetReference}):`
        );
    }
    for (const finding of result.newFindings) {
        console.log(`${toRelativePath(result.repoRoot, finding.file)} [${finding.ruleId}]`);
        console.log(`  ${finding.message}`);
    }
    process.exitCode = 1;
}

function readChanges(mergeBase, targetReference, repoRoot) {
    const args = ['diff', '--name-status', '--find-renames', mergeBase];
    if (targetReference !== worktreeTarget) {
        args.push(targetReference);
    }
    const changes = parseNameStatus(runGit(args));
    if (targetReference === worktreeTarget) {
        const untracked = runGit(['ls-files', '--others', '--exclude-standard'])
            .split('\n')
            .filter(Boolean);
        changes.push(...untracked.map((file) => ({ kind: 'A', source: undefined, target: file })));
    }
    return changes.filter((change) =>
        [change.source, change.target]
            .filter(Boolean)
            .some((file) => isGovernedSourceFile(path.join(repoRoot, file)))
    );
}

function parseNameStatus(source) {
    return source
        .split('\n')
        .filter(Boolean)
        .map((line) => {
            const [status, firstPath, secondPath] = line.split('\t');
            const kind = status[0];
            if (kind === 'R' || kind === 'C') {
                return { kind, source: firstPath, target: secondPath };
            }
            return {
                kind,
                source: kind === 'A' ? undefined : firstPath,
                target: kind === 'D' ? undefined : firstPath
            };
        });
}

function toBaseSources(input) {
    const sourceByPath = new Map(
        input.targetSources.map((source) => [toRelativePath(input.repoRoot, source.file), source])
    );
    for (const change of input.changes) {
        if (change.target !== undefined && change.kind !== 'M' && change.kind !== 'T') {
            sourceByPath.delete(change.target);
        }
        if (change.source === undefined) {
            continue;
        }
        const baseSource = readRevisionFile(input.mergeBase, change.source);
        if (
            baseSource !== undefined &&
            isGovernedSourceFile(path.join(input.repoRoot, change.source))
        ) {
            sourceByPath.set(change.source, {
                file: path.join(input.repoRoot, change.source),
                raw: baseSource
            });
        }
    }
    return [...sourceByPath.values()].sort((left, right) => left.file.localeCompare(right.file));
}

function subtractExistingFindings(input) {
    const newFindingSet = new Set();
    const baseBoundaryCapacityByPath = groupStructuralBoundaryCapacity({
        repoRoot: input.repoRoot,
        findings: input.baseFindings,
        structuralLineageSourcePaths: input.structuralLineageSourcePaths,
        logicalSourceByTargetPath: new Map()
    });
    const regularTargetFindings = [];
    for (const finding of input.targetFindings) {
        const logicalPath = findingLogicalPath(
            input.repoRoot,
            finding,
            input.logicalSourceByTargetPath
        );
        if (
            finding.ruleId !== 'boundary.unknown' ||
            !input.structuralLineageSourcePaths.has(logicalPath)
        ) {
            regularTargetFindings.push(finding);
            continue;
        }
        const targetMagnitude = boundaryUnknownMagnitude(finding);
        const baseCapacity = baseBoundaryCapacityByPath.get(logicalPath) ?? 0;
        if (baseCapacity < targetMagnitude) {
            newFindingSet.add(finding);
            continue;
        }
        baseBoundaryCapacityByPath.set(logicalPath, baseCapacity - targetMagnitude);
    }

    const baseMagnitudesByKey = groupFindingMagnitudes(input.repoRoot, input.baseFindings, new Map());
    const targetFindingsByKey = groupFindings(
        input.repoRoot,
        regularTargetFindings,
        input.logicalSourceByTargetPath
    );
    for (const [key, findings] of targetFindingsByKey) {
        const baseMagnitudes = baseMagnitudesByKey.get(key) ?? [];
        for (const finding of findings.toSorted(compareFindingMagnitudeDescending)) {
            const targetMagnitude = findingMagnitude(finding);
            const matchIndex = baseMagnitudes.findIndex((baseMagnitude) =>
                matchesBaseMagnitude(finding.ruleId, baseMagnitude, targetMagnitude)
            );
            if (matchIndex < 0) {
                newFindingSet.add(finding);
                continue;
            }
            baseMagnitudes.splice(matchIndex, 1);
        }
    }
    return input.targetFindings.filter((finding) => newFindingSet.has(finding));
}

function groupStructuralBoundaryCapacity(input) {
    const capacityByPath = new Map();
    for (const finding of input.findings) {
        const logicalPath = findingLogicalPath(
            input.repoRoot,
            finding,
            input.logicalSourceByTargetPath
        );
        if (
            finding.ruleId === 'boundary.unknown' &&
            input.structuralLineageSourcePaths.has(logicalPath)
        ) {
            const capacity = capacityByPath.get(logicalPath) ?? 0;
            capacityByPath.set(logicalPath, capacity + boundaryUnknownMagnitude(finding));
        }
    }
    return capacityByPath;
}

function findingKey(repoRoot, finding, logicalSourceByTargetPath) {
    const logicalPath = findingLogicalPath(repoRoot, finding, logicalSourceByTargetPath);
    return [logicalPath, finding.ruleId, findingVariant(finding)].join('\0');
}

function findingLogicalPath(repoRoot, finding, logicalSourceByTargetPath) {
    const targetPath = toRelativePath(repoRoot, finding.file);
    return finding.ruleId.startsWith('layout.')
        ? targetPath
        : (logicalSourceByTargetPath.get(targetPath) ?? targetPath);
}

function groupFindingMagnitudes(repoRoot, findings, renameByTargetPath) {
    const magnitudesByKey = new Map();
    for (const finding of findings) {
        const key = findingKey(repoRoot, finding, renameByTargetPath);
        const magnitudes = magnitudesByKey.get(key) ?? [];
        magnitudes.push(findingMagnitude(finding));
        magnitudes.sort((left, right) => right - left);
        magnitudesByKey.set(key, magnitudes);
    }
    return magnitudesByKey;
}

function groupFindings(repoRoot, findings, renameByTargetPath) {
    const findingsByKey = new Map();
    for (const finding of findings) {
        const key = findingKey(repoRoot, finding, renameByTargetPath);
        const grouped = findingsByKey.get(key) ?? [];
        grouped.push(finding);
        findingsByKey.set(key, grouped);
    }
    return findingsByKey;
}

function findingVariant(finding) {
    if (finding.ruleId === 'layout.feature-prefix-cluster') {
        const prefixMatch = /prefix '([^']+)' appears/u.exec(finding.message);
        return prefixMatch === null ? finding.message : `prefix:${prefixMatch[1]}`;
    }
    return finding.message.startsWith('... and ') ? 'summary' : 'detail';
}

function toRenameMap(changes) {
    return new Map(
        changes.filter((change) => change.kind === 'R').map((change) => [change.target, change.source])
    );
}

function readRevisionProductionSources(repoRoot, revision) {
    return runGit(['ls-tree', '-r', '--name-only', revision])
        .split('\n')
        .filter(Boolean)
        .filter((file) => isGovernedSourceFile(path.join(repoRoot, file)))
        .map((file) => ({
            file: path.join(repoRoot, file),
            raw: readRevisionFile(revision, file)
        }))
        .filter((source) => source.raw !== undefined);
}

function readRevisionFile(revision, file) {
    const result = runGitResult(['show', `${revision}:${file}`]);
    return result.status === 0 ? result.stdout : undefined;
}

function resolveCommit(reference, role) {
    const result = runGitResult(['rev-parse', '--verify', `${reference}^{commit}`]);
    if (result.status === 0) {
        return result.stdout.trim();
    }
    console.error(`Could not resolve ${role} reference: ${reference}`);
    process.exitCode = 2;
    return undefined;
}

function runGit(args) {
    const result = runGitResult(args);
    if (result.status !== 0) {
        throw new Error(result.stderr.trim() || `git ${args.join(' ')} failed`);
    }
    return result.stdout;
}

function runGitResult(args) {
    return spawnSync('git', args, { encoding: 'utf8' });
}

function toRelativePath(repoRoot, file) {
    return path.relative(repoRoot, file).split(path.sep).join('/');
}

function failUsage(message) {
    console.error(message);
    console.error('Usage: node scripts/check-changed-repo-style.mjs <base-ref> [HEAD|WORKTREE]');
    process.exitCode = 2;
}

main().catch((error) => {
    if (error instanceof StructuralLineageValidationError) {
        console.error(error.message);
    }
    else {
        console.error('changed repository style check failed:', error.message);
    }
    process.exitCode = 2;
});
