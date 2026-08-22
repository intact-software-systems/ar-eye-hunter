import { lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { readGitRepositorySnapshot } from '../governance-decisions/git-repository-snapshot.mjs';
import { mutableCapabilityClaims } from './adaptive-plan-capabilities.mjs';
import { parseAdaptivePlanRecord } from './adaptive-plan-record.mjs';

const policyKeys = ['maxActivePlans', 'schemaVersion'];

export function readAdaptivePlanPolicy(repoRoot) {
    const policyPath = path.join(resolvePlansRoot(repoRoot), 'policy.json');
    const stat = lstatSync(policyPath);
    if (!stat.isFile() || stat.isSymbolicLink()) {
        throw new Error('adaptive plan policy must be a regular file');
    }
    return parseAdaptivePlanPolicy(readFileSync(policyPath, 'utf8'));
}

function parseAdaptivePlanPolicy(source) {
    const policy = JSON.parse(source);
    if (JSON.stringify(Object.keys(policy ?? {}).sort()) !== JSON.stringify(policyKeys)) {
        throw new Error(`adaptive plan policy must contain exactly ${policyKeys.join(', ')}`);
    }
    if (policy.schemaVersion !== 'adaptive-plan-policy-v1') {
        throw new Error('adaptive plan policy schemaVersion must be adaptive-plan-policy-v1');
    }
    if (!Number.isSafeInteger(policy.maxActivePlans) || policy.maxActivePlans <= 0) {
        throw new Error('adaptive plan policy maxActivePlans must be a positive safe integer');
    }
    return policy;
}

export function readAdaptivePlans(repoRoot) {
    const plansRoot = resolvePlansRoot(repoRoot);
    return readdirSync(plansRoot, { withFileTypes: true })
        .filter((entry) => entry.name.endsWith('.md') && entry.name !== 'README.md')
        .flatMap((entry) => {
            if (entry.isSymbolicLink() || !entry.isFile()) {
                throw new Error(`adaptive plan must be a regular file: plans/${entry.name}`);
            }
            const planPath = `plans/${entry.name}`;
            const markdown = readFileSync(path.join(plansRoot, entry.name), 'utf8');
            return markdown.includes('```plan-adaptation-v1')
                ? [{ planPath, record: parseAdaptivePlanRecord(markdown, planPath) }]
                : [];
        })
        .sort((left, right) => compareText(left.record.planId, right.record.planId));
}

export const readAdaptivePlanCatalog = (repoRoot) =>
    evaluateAdaptivePlanCatalog(readAdaptivePlanPolicy(repoRoot), readAdaptivePlans(repoRoot));

export const readAdaptivePlanCatalogAtRevision = (repoRoot, revision) =>
    readAdaptivePlanCatalogFromEntries(
        readGitRepositorySnapshot({ repoRoot, commitOid: revision }).entries
    );

export function readAdaptivePlanCatalogFromEntries(entries) {
    const policyEntry = entries.find((entry) => entry.path === 'plans/policy.json');
    if (policyEntry?.mode !== '100644') {
        throw new Error('adaptive plan policy must be a regular file');
    }
    const policy = parseAdaptivePlanPolicy(policyEntry.content);
    const plans = entries
        .filter(
            (entry) =>
                entry.mode === '100644' &&
                /^plans\/[^/]+\.md$/u.test(entry.path) &&
                entry.path !== 'plans/README.md' &&
                entry.content.includes('```plan-adaptation-v1')
        )
        .map((entry) => ({
            planPath: entry.path,
            record: parseAdaptivePlanRecord(entry.content, entry.path)
        }))
        .sort((left, right) => compareText(left.record.planId, right.record.planId));
    return evaluateAdaptivePlanCatalog(policy, plans);
}

export function evaluateAdaptivePlanCatalogRecovery(input) {
    if (input.baseCatalog.issues.length === 0) {
        return { attempted: false, allowed: false, issues: [] };
    }
    const invalidPaths = input.changedPaths.filter(
        (changedPath) => !isCatalogRecoveryPath(changedPath, input.authenticatedDisposition === true)
    );
    const issues = [];
    if (invalidPaths.length > 0) {
        issues.push(
            `catalog recovery may change only plan governance paths: ${
                [...new Set(invalidPaths)]
                    .sort()
                    .join(', ')
            }`
        );
    }
    const base = input.baseCatalog;
    const candidate = input.candidateCatalog;
    const excessImproved = candidate.capacity.excess < base.capacity.excess;
    const overlapsImproved = candidate.ownershipConflicts.length < base.ownershipConflicts.length;
    if (
        candidate.capacity.excess > base.capacity.excess ||
        candidate.ownershipConflicts.length > base.ownershipConflicts.length ||
        (!excessImproved && !overlapsImproved)
    ) {
        issues.push('catalog recovery must strictly reduce capacity excess or ownership overlap');
    }
    return { attempted: true, allowed: issues.length === 0, issues };
}

export function evaluateAdaptivePlanCatalog(policy, plans) {
    const activePlans = plans.filter(({ record }) => record.status === 'active');
    const postponedPlans = plans.filter(({ record }) => record.status === 'postponed');
    const excess = Math.max(0, activePlans.length - policy.maxActivePlans);
    const capacity = {
        active: activePlans.length,
        postponed: postponedPlans.length,
        maximum: policy.maxActivePlans,
        remaining: Math.max(0, policy.maxActivePlans - activePlans.length),
        excess
    };
    const ownershipConflicts = readOwnershipConflicts(activePlans);
    const issues = ownershipConflicts.map(
        (conflict) =>
            `mutable ownership overlap between ${conflict.leftPlanId} and ` +
            `${conflict.rightPlanId}: ${conflict.paths.join(', ')}`
    );
    if (excess > 0) {
        issues.unshift(
            `active plan capacity ${activePlans.length}/${policy.maxActivePlans} exceeded: ` +
                activePlans.map(({ record }) => record.planId).join(', ')
        );
    }
    return { policy, plans, activePlans, postponedPlans, capacity, ownershipConflicts, issues };
}

export function toAdaptivePlanOverview(catalog) {
    const rows = catalog.plans.map(
        ({ record }) =>
            `| ${cell(record.planId)} | ${cell(record.status)} | ` +
            `${cell(record.capabilities.map(({ owner }) => owner).join(', '))} | ` +
            `${cell(record.checkpoint.decision)} | ${cell(record.checkpoint.nextSlices.join(', '))} |`
    );
    return (
        '# Adaptive plan overview\n\n' +
        `Capacity: ${catalog.capacity.active}/${catalog.capacity.maximum} active, ` +
        `${catalog.capacity.postponed} postponed, ${catalog.capacity.remaining} available.\n\n` +
        '| Plan | Status | Capability owners | Checkpoint | Next slices |\n' +
        `| --- | --- | --- | --- | --- |\n${rows.join('\n')}\n`
    );
}

export function writeAdaptivePlanOverview(repoRoot) {
    const outputPath = path.join(resolvePlanAdaptationOutputRoot(repoRoot), 'overview.md');
    writeFileSync(outputPath, toAdaptivePlanOverview(readAdaptivePlanCatalog(repoRoot)));
    return outputPath;
}

export const resolvePlanAdaptationOutputRoot = (repoRoot) =>
    resolveRepositoryDirectory(repoRoot, '.plan-adaptation', true);

export const resolvePlansRoot = (repoRoot) => resolveRepositoryDirectory(repoRoot, 'plans', false);

function resolveRepositoryDirectory(repoRoot, directory, create) {
    const outputRoot = path.join(realpathSync(repoRoot), directory);
    if (create) {
        mkdirSync(outputRoot, { recursive: true });
    }
    const stat = lstatSync(outputRoot);
    if (!stat.isDirectory() || stat.isSymbolicLink() || realpathSync(outputRoot) !== outputRoot) {
        throw new Error(`${directory} directory must remain inside the repository`);
    }
    return outputRoot;
}

function readOwnershipConflicts(activePlans) {
    const conflicts = [];
    for (const [index, left] of activePlans.entries()) {
        for (const right of activePlans.slice(index + 1)) {
            const paths = [];
            const leftClaims = left.record.capabilities.flatMap(mutableCapabilityClaims);
            const rightClaims = right.record.capabilities.flatMap(mutableCapabilityClaims);
            for (const leftClaim of leftClaims) {
                for (const rightClaim of rightClaims) {
                    if (claimsOverlap(leftClaim, rightClaim)) {
                        paths.push(`${leftClaim.value} <> ${rightClaim.value}`);
                    }
                }
            }
            if (paths.length > 0) {
                conflicts.push({
                    leftPlanId: left.record.planId,
                    rightPlanId: right.record.planId,
                    paths: [...new Set(paths)].sort(compareText)
                });
            }
        }
    }
    return conflicts;
}

function claimsOverlap(left, right) {
    if (left.kind === 'path' && right.kind === 'path') {
        return left.value === right.value;
    }
    if (left.kind === 'root' && right.kind === 'root') {
        return isWithin(left.value, right.value) || isWithin(right.value, left.value);
    }
    const root = left.kind === 'root' ? left.value : right.value;
    const exactPath = left.kind === 'path' ? left.value : right.value;
    return isWithin(exactPath, root);
}

function isWithin(candidate, root) {
    return candidate === root || candidate.startsWith(`${root}/`);
}

function isCatalogRecoveryPath(repositoryPath, authenticatedDisposition) {
    return (
        /^plans\/[a-z0-9]+(?:-[a-z0-9]+)*\.md$/u.test(repositoryPath) ||
        repositoryPath === 'plans/policy.json' ||
        /^plans\/[a-z0-9]+(?:-[a-z0-9]+)*\.closure\.json$/u.test(repositoryPath) ||
        (authenticatedDisposition &&
            /^governance\/decisions\/[0-9a-f]{64}\.json$/u.test(repositoryPath))
    );
}

function cell(value) {
    return String(value).replaceAll('|', '\\|').replaceAll('\n', ' ');
}

function compareText(left, right) {
    return Buffer.compare(Buffer.from(String(left)), Buffer.from(String(right)));
}
