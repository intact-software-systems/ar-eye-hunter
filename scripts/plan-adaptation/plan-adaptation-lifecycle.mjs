import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync } from 'node:fs';
import path from 'node:path';

import {
  computeAdaptivePlanRecordDigest,
  computeCheckpointDigest,
  parseAdaptivePlanRecord,
  replaceAdaptivePlanRecord,
  validateAdaptivePlanRecord,
} from './adaptive-plan-record.mjs';
import { hasConsolidationDecision, validateCheckpoint } from './adaptive-plan-policy.mjs';
import {
  readAdaptivePlans,
  readActivePlans,
  resolveActivePlanRegistryPath,
  resolvePlansRoot,
  toActivePlanRegistry,
} from './active-plan-registry.mjs';
import { writeFileTransaction } from './file-transaction.mjs';
import {
  computePlanFacts,
  computeQualificationReasons,
  readChangedPaths,
} from './plan-change-facts.mjs';

export function initAdaptivePlan(input) {
  const plan = readPlan(input);
  validateRecordAndCheckpoint(plan.record);
  plan.record.facts = readCurrentFacts(input, plan.record);
  writePlanAndRegistry({ input, markdown: plan.markdown, record: plan.record });
}

export function completeAdaptivePlanSlice(input) {
  const plan = readPlan(input);
  validateRecordAndCheckpoint(plan.record);
  if (plan.record.completedSlicesSinceCheckpoint.includes(input.slice)) {
    throw new Error(`slice ${input.slice} is already complete since the prior checkpoint`);
  }
  if (!plan.record.checkpoint.nextSlices.includes(input.slice)) {
    throw new Error(`slice ${input.slice} is not in the current horizon`);
  }
  plan.record.completedSlicesSinceCheckpoint.push(input.slice);
  plan.record.checkpoint.nextSlices = plan.record.checkpoint.nextSlices.filter(
    (slice) => slice !== input.slice,
  );
  plan.record.facts = readCurrentFacts(input, plan.record);
  writePlanAndRegistry({ input, markdown: plan.markdown, record: plan.record });
}

export function prepareAdaptivePlan(input) {
  const plan = readPlan(input);
  validateRecordAndCheckpoint(plan.record);
  const sourceRecordDigest = computeAdaptivePlanRecordDigest(plan.record);
  plan.record.facts = readCurrentFacts(input, plan.record);
  plan.record.checkpoint = {
    outcome: '',
    learning: '',
    structure: '',
    decision: '',
    nextSlices: [],
  };
  const draftPath = toDraftPath(input.repoRoot, plan.record.planId);
  writeFileTransaction({
    replacements: [
      {
        path: draftPath,
        content: `${JSON.stringify(
          { version: 1, planPath: input.planPath, sourceRecordDigest, record: plan.record },
          null,
          2,
        )}\n`,
      },
    ],
  });
  return path.relative(input.repoRoot, draftPath);
}

export function applyAdaptivePlan(input) {
  const plan = readPlan(input);
  const draftPath = toDraftPath(input.repoRoot, plan.record.planId);
  const draft = readDraft(draftPath);
  if (
    draft.version !== 1 ||
    draft.planPath !== input.planPath ||
    draft.record?.planId !== plan.record.planId
  ) {
    throw new Error('draft does not identify the current adaptive plan');
  }
  if (draft.sourceRecordDigest !== computeAdaptivePlanRecordDigest(plan.record)) {
    throw new Error('source plan record changed after prepare; run prepare again');
  }
  if (draft.record.checkpoint.decision === 'consolidate' && hasConsolidationDecision(plan.record)) {
    throw new Error('only one autonomous consolidation slice is allowed');
  }
  validateRecordAndCheckpoint(draft.record);
  const currentFacts = readCurrentFacts(input, draft.record);
  if (JSON.stringify(currentFacts) !== JSON.stringify(draft.record.facts)) {
    throw new Error('draft facts are stale; run prepare again');
  }
  appendMaterialDecision(draft.record);
  draft.record.completedSlicesSinceCheckpoint = [];
  writePlanAndRegistry({
    input,
    markdown: plan.markdown,
    record: draft.record,
    removals: [draftPath],
  });
}

export function checkAdaptivePlans(input) {
  const changes = readChangedPaths(input.repoRoot, input.base);
  const qualification = computeQualificationReasons(input.repoRoot, input.base, changes);
  const adaptivePlans = readAdaptivePlans(input.repoRoot);
  const activePlans = adaptivePlans.filter(({ record }) => record.status === 'active');
  const issues = [];
  for (const adaptivePlan of adaptivePlans) {
    issues.push(...validateAdaptivePlanRecord(adaptivePlan.record));
    issues.push(...validateCheckpoint(adaptivePlan.record.checkpoint, adaptivePlan.record));
  }
  if (qualification.length > 0 && activePlans.length === 0) {
    issues.push(
      `qualifying work requires an active plan-adaptation-v1 record: ${qualification.join(', ')}`,
    );
  }
  for (const activePlan of activePlans) {
    const factBase =
      typeof activePlan.record.facts?.diffBase === 'string'
        ? activePlan.record.facts.diffBase
        : input.base;
    const currentFacts = readCurrentFacts(
      {
        ...input,
        planPath: activePlan.planPath,
        base: factBase,
      },
      activePlan.record,
    );
    if (JSON.stringify(currentFacts) !== JSON.stringify(activePlan.record.facts)) {
      issues.push(`${activePlan.planPath} computed facts are stale`);
    }
  }
  const registryPath = resolveActivePlanRegistryPath(input.repoRoot);
  const expectedRegistry = toActivePlanRegistry(activePlans);
  if (!existsSync(registryPath) || readFileSync(registryPath, 'utf8') !== expectedRegistry) {
    issues.push('plans/README.md is not the generated active-plan registry');
  }
  if (issues.length > 0) {
    throw new Error(issues.join('\n'));
  }
}

export function closeAdaptivePlan(input) {
  const plan = readPlan(input);
  validateRecordAndCheckpoint(plan.record);
  validateFinalEvidence(input, plan.record);
  const activePlans = readActivePlans(input.repoRoot);
  const registryPath = resolveActivePlanRegistryPath(input.repoRoot);
  const currentRegistry = readFileSync(registryPath, 'utf8');
  if (
    currentRegistry !== toActivePlanRegistry(activePlans) ||
    !activePlans.some(
      (entry) => entry.planPath === input.planPath && entry.record.planId === plan.record.planId,
    )
  ) {
    throw new Error('close requires the plan to be the current active registry entry');
  }
  writeFileTransaction({
    replacements: [
      {
        path: registryPath,
        content: toActivePlanRegistry(
          activePlans.filter((entry) => entry.planPath !== input.planPath),
        ),
      },
    ],
    removals: [plan.absolutePath],
  });
}

function readPlan(input) {
  const absolutePath = resolveTacticalPlanPath(input.repoRoot, input.planPath);
  const markdown = readFileSync(absolutePath, 'utf8');
  return { absolutePath, markdown, record: parseAdaptivePlanRecord(markdown, input.planPath) };
}

function writePlanAndRegistry(transaction) {
  const { input, markdown, record, removals = [] } = transaction;
  const planPath = resolveTacticalPlanPath(input.repoRoot, input.planPath);
  const adaptivePlans = readAdaptivePlans(input.repoRoot).map((entry) => {
    return entry.planPath === input.planPath ? { ...entry, record } : entry;
  });
  const activePlans = adaptivePlans.filter((entry) => entry.record.status === 'active');
  writeFileTransaction({
    replacements: [
      {
        path: planPath,
        content: replaceAdaptivePlanRecord(markdown, record, input.planPath),
      },
      {
        path: resolveActivePlanRegistryPath(input.repoRoot),
        content: toActivePlanRegistry(activePlans),
      },
    ],
    removals,
  });
}

function readCurrentFacts(input, record) {
  const changes = readChangedPaths(input.repoRoot, input.base);
  return computePlanFacts({
    repoRoot: input.repoRoot,
    base: input.base,
    changes,
    record,
    planPath: input.planPath,
  });
}

function validateRecordAndCheckpoint(record) {
  const issues = [
    ...validateAdaptivePlanRecord(record),
    ...validateCheckpoint(record.checkpoint, record),
  ];
  if (issues.length > 0) {
    throw new Error(issues.join('\n'));
  }
}

function readDraft(draftPath) {
  if (!existsSync(draftPath)) {
    throw new Error('prepared draft is missing; run prepare first');
  }
  try {
    return JSON.parse(readFileSync(draftPath, 'utf8'));
  } catch (error) {
    throw new Error(`prepared draft contains invalid JSON: ${toError(error).message}`);
  }
}

function appendMaterialDecision(record) {
  const checkpointDigest = computeCheckpointDigest(record.checkpoint);
  record.materialDecisions.push({
    date: new Date().toISOString().slice(0, 10),
    decision: record.checkpoint.decision,
    summary: record.checkpoint.outcome,
    ...(record.checkpoint.decision === 'consolidate' ? { checkpointDigest } : {}),
  });
}

function validateFinalEvidence(input, record) {
  const evidencePath = input.finalPrEvidence
    ? resolveRepositoryFile(input.repoRoot, input.finalPrEvidence, 'final pull-request evidence')
    : undefined;
  if (!evidencePath || !existsSync(evidencePath)) {
    throw new Error('final pull-request evidence is missing');
  }
  let evidence;
  try {
    evidence = JSON.parse(readFileSync(evidencePath, 'utf8'));
  } catch (error) {
    throw new Error(`final pull-request evidence is invalid: ${toError(error).message}`);
  }
  const valid =
    evidence.version === 1 &&
    evidence.planId === record.planId &&
    /^https:\/\/github\.com\/[^/]+\/[^/]+\/pull\/\d+$/u.test(evidence.pullRequestUrl) &&
    evidence.finalReview?.status === 'complete' &&
    evidence.finalReview?.planDigest === computeAdaptivePlanRecordDigest(record);
  if (!valid) {
    throw new Error(
      'final pull-request evidence does not match the current plan and completed review',
    );
  }
}

function toDraftPath(repoRoot, planId) {
  if (typeof planId !== 'string' || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(planId)) {
    throw new Error('record.planId must use lowercase letters, digits, and single hyphens');
  }
  const realRepoRoot = realpathSync(repoRoot);
  const draftRoot = path.join(realRepoRoot, '.plan-adaptation');
  mkdirSync(draftRoot, { recursive: true });
  const stat = lstatSync(draftRoot);
  if (!stat.isDirectory() || stat.isSymbolicLink() || realpathSync(draftRoot) !== draftRoot) {
    throw new Error('draft directory must remain inside the repository');
  }
  return path.join(draftRoot, `${planId}.draft.json`);
}

function resolveTacticalPlanPath(repoRoot, planPath) {
  if (
    typeof planPath !== 'string' ||
    !/^plans\/[a-z0-9]+(?:-[a-z0-9]+)*\.md$/u.test(planPath) ||
    planPath === 'plans/README.md'
  ) {
    throw new Error('plan path must identify a direct plans/*.md tactical plan');
  }
  const plansRoot = resolvePlansRoot(repoRoot);
  const absolutePath = path.join(plansRoot, path.basename(planPath));
  if (existsSync(absolutePath)) {
    const stat = lstatSync(absolutePath);
    if (stat.isSymbolicLink()) {
      throw new Error('plan path must not be a symbolic link');
    }
    if (!stat.isFile()) {
      throw new Error('plan path must identify a regular file');
    }
  }
  return absolutePath;
}

function resolveRepositoryFile(repoRoot, relativePath, name) {
  if (
    typeof relativePath !== 'string' ||
    path.isAbsolute(relativePath) ||
    relativePath.split('/').some((part) => part === '' || part === '.' || part === '..')
  ) {
    throw new Error(`${name} path must remain inside the repository`);
  }
  const absolutePath = path.resolve(repoRoot, relativePath);
  const relative = path.relative(realpathSync(repoRoot), absolutePath);
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error(`${name} path must remain inside the repository`);
  }
  if (existsSync(absolutePath)) {
    const stat = lstatSync(absolutePath);
    if (!stat.isFile() || stat.isSymbolicLink()) {
      throw new Error(`${name} path must identify a regular file`);
    }
    const realPath = realpathSync(absolutePath);
    const realRelative = path.relative(realpathSync(repoRoot), realPath);
    if (realRelative.startsWith('..') || path.isAbsolute(realRelative)) {
      throw new Error(`${name} path must remain inside the repository`);
    }
  }
  return absolutePath;
}

function toError(value) {
  return value instanceof Error ? value : new Error(String(value));
}
