import { existsSync, lstatSync, readFileSync, realpathSync } from 'node:fs';
import path from 'node:path';

import {
  computeAdaptivePlanRecordDigest,
  computeCheckpointDigest,
  parseAdaptivePlanRecord,
  replaceAdaptivePlanRecord,
  isPlannedCapability,
  validateAdaptivePlanRecord,
} from './adaptive-plan-record.mjs';
import { hasConsolidationDecision, validateCheckpoint } from './adaptive-plan-policy.mjs';
import {
  evaluateAdaptivePlanCatalog,
  evaluateAdaptivePlanCatalogRecovery,
  readAdaptivePlanCatalog,
  readAdaptivePlanCatalogAtRevision,
  resolvePlanAdaptationOutputRoot,
  resolvePlansRoot,
} from './adaptive-plan-catalog.mjs';
import { writeFileTransaction } from './file-transaction.mjs';
import { createPlanClosureReceipt } from './plan-closure-receipt.mjs';
import { readAuthenticatedPlanTransitionChanges } from './plan-transition-authentication.mjs';
import {
  computePlanFacts,
  computeQualificationReasons,
  computeUnassignedQualifyingPaths,
  hasCurrentPlanFacts,
  readChangedPaths,
  selectPlanChanges,
} from './plan-change-facts.mjs';

export function initAdaptivePlan(input) {
  const plan = readPlan(input);
  requireActivePlan(plan, 'init');
  validateRecordAndCheckpoint(plan.record);
  plan.record.facts = readCurrentFacts({ input, record: plan.record });
  writePlan({ input, markdown: plan.markdown, record: plan.record });
}

export function completeAdaptivePlanSlice(input) {
  const plan = readPlan(input);
  requireActivePlan(plan, 'complete-slice');
  validateRecordAndCheckpoint(plan.record);
  if (plan.record.completedSlicesSinceCheckpoint.includes(input.slice)) {
    throw new Error(`slice ${input.slice} is already complete since the prior checkpoint`);
  }
  if (!plan.record.checkpoint.nextSlices.includes(input.slice)) {
    throw new Error(`slice ${input.slice} is not in the current horizon`);
  }
  const plannedOwners = plan.record.capabilities
    .filter(
      (capability) =>
        isPlannedCapability(capability) && capability.activation.slice === input.slice,
    )
    .map((capability) => capability.owner);
  if (plannedOwners.length > 0) {
    throw new Error(
      `slice ${input.slice} has planned capabilities: ${plannedOwners.join(', ')}; ` +
        'activate them before completion',
    );
  }
  plan.record.completedSlicesSinceCheckpoint.push(input.slice);
  plan.record.checkpoint.nextSlices = plan.record.checkpoint.nextSlices.filter(
    (slice) => slice !== input.slice,
  );
  plan.record.facts = readCurrentFacts({ input, record: plan.record });
  writePlan({ input, markdown: plan.markdown, record: plan.record });
}

export function prepareAdaptivePlan(input) {
  const plan = readPlan(input);
  requireActivePlan(plan, 'prepare');
  validateRecordAndCheckpoint(plan.record);
  const sourceRecordDigest = computeAdaptivePlanRecordDigest(plan.record);
  plan.record.facts = readCurrentFacts({ input, record: plan.record, includeUnassigned: true });
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
  requireActivePlan(plan, 'apply');
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
  const currentFacts = readCurrentFacts({ input, record: draft.record, includeUnassigned: true });
  if (JSON.stringify(currentFacts) !== JSON.stringify(draft.record.facts)) {
    throw new Error('draft facts are stale; run prepare again');
  }
  appendMaterialDecision(draft.record);
  draft.record.completedSlicesSinceCheckpoint = [];
  writePlan({
    input,
    markdown: plan.markdown,
    record: draft.record,
    removals: [draftPath],
  });
}

export function checkAdaptivePlans(input) {
  const changes = readChangedPaths(input.repoRoot, input.base);
  const closureChanges = readAuthenticatedPlanTransitionChanges({
    repoRoot: input.repoRoot,
    base: input.base,
    changes,
    readGateEvidence: input.readGateEvidence,
    readDecisionAdmissionEvidence: input.readDecisionAdmissionEvidence,
  });
  const qualification = computeQualificationReasons(
    input.repoRoot,
    input.base,
    closureChanges.changes,
  );
  const catalog = readAdaptivePlanCatalog(input.repoRoot);
  const adaptivePlans = catalog.plans;
  const activePlans = catalog.activePlans;
  const recovery = readCatalogRecovery({
    input, candidateCatalog: catalog, changes, authenticatedChanges: closureChanges,
  });
  const issues = [];
  if (!recovery.allowed) issues.push(...catalog.issues);
  issues.push(...closureChanges.issues);
  for (const adaptivePlan of adaptivePlans) {
    issues.push(...validateAdaptivePlanRecord(adaptivePlan.record));
    issues.push(...validateCheckpoint(adaptivePlan.record.checkpoint, adaptivePlan.record));
  }
  if (recovery.attempted) {
    issues.push(...recovery.issues);
    if (issues.length > 0) throw new Error(issues.join('\n'));
    return;
  }
  if (qualification.length > 0 && activePlans.length === 0) {
    issues.push(
      `qualifying work requires an active plan-adaptation-v1 record: ${qualification.join(', ')}`,
    );
  }
  const unassignedPaths = computeUnassignedQualifyingPaths({
    repoRoot: input.repoRoot,
    base: input.base,
    changes: closureChanges.changes,
    catalog,
  });
  if (unassignedPaths.length > 0) {
    issues.push(
      `unassigned qualifying scope: ${unassignedPaths.join(', ')}; candidate plans: ` +
        activePlans.map(({ record }) => record.planId).join(', '),
    );
  }
  for (const activePlan of activePlans) {
    const authenticatedRepair = closureChanges.authenticatedDispositions.find(
      (disposition) =>
        disposition.operation === 'plan.repair' && disposition.planPath === activePlan.planPath,
    );
    if (authenticatedRepair && closureChanges.changes.length === 0) {
      continue;
    }
    const factBase =
      typeof activePlan.record.facts?.diffBase === 'string'
        ? activePlan.record.facts.diffBase
        : input.base;
    const factChanges =
      factBase === input.base
        ? closureChanges
        : readAuthenticatedPlanTransitionChanges({
            repoRoot: input.repoRoot,
            base: factBase,
            changes: readChangedPaths(input.repoRoot, factBase),
            readGateEvidence: input.readGateEvidence,
            readDecisionAdmissionEvidence: input.readDecisionAdmissionEvidence,
          });
    issues.push(...factChanges.issues);
    const scopedChanges = selectPlanChanges({
      changes: factChanges.changes,
      catalog,
      planPath: activePlan.planPath,
    });
    if (
      !hasCurrentPlanFacts({
        repoRoot: input.repoRoot,
        base: factBase,
        changes: scopedChanges,
        record: activePlan.record,
        planPath: activePlan.planPath,
      })
    ) {
      issues.push(`${activePlan.planPath} computed facts are stale`);
    }
  }
  if (issues.length > 0) {
    throw new Error(issues.join('\n'));
  }
}

function readCatalogRecovery({ input, candidateCatalog, changes, authenticatedChanges }) {
  try {
    return evaluateAdaptivePlanCatalogRecovery({
      baseCatalog: readAdaptivePlanCatalogAtRevision(input.repoRoot, input.base),
      candidateCatalog,
      authenticatedDisposition: authenticatedChanges.authenticatedDispositions.length > 0,
      changedPaths: changes.flatMap((change) => [change.oldPath, change.path]).filter(Boolean),
    });
  } catch {
    return { attempted: false, allowed: false, issues: [] };
  }
}

export function closeAdaptivePlan(input) {
  const plan = readPlan(input);
  validateRecordAndCheckpoint(plan.record);
  const plannedOwners = plan.record.capabilities
    .filter(isPlannedCapability)
    .map((capability) => capability.owner);
  if (plannedOwners.length > 0) {
    throw new Error(
      `close cannot continue while planned capabilities remain: ${plannedOwners.join(', ')}`,
    );
  }
  const evidence = validateFinalEvidence(input, plan.record);
  const receipt = createPlanClosureReceipt({
    repoRoot: input.repoRoot,
    base: input.base,
    planPath: input.planPath,
    record: plan.record,
    evidence,
  });
  writeFileTransaction({
    replacements: [receipt],
    removals: [plan.absolutePath],
  });
}

export function postponeAdaptivePlan(input) {
  const plan = readPlan(input);
  validateRecordAndCheckpoint(plan.record);
  requireActivePlan(plan, 'postpone');
  plan.record.status = 'postponed';
  appendStatusDecision(plan.record, 'postpone', input.reason);
  writePlan({ input, markdown: plan.markdown, record: plan.record });
}

export function resumeAdaptivePlan(input) {
  const plan = readPlan(input);
  validateRecordAndCheckpoint(plan.record);
  if (plan.record.status !== 'postponed') throw new Error('resume requires a postponed plan');
  plan.record.status = 'active';
  const catalog = readAdaptivePlanCatalog(input.repoRoot);
  const candidate = evaluateAdaptivePlanCatalog(
    catalog.policy,
    catalog.plans.map((entry) =>
      entry.planPath === input.planPath ? { ...entry, record: plan.record } : entry,
    ),
  );
  if (candidate.issues.length > 0) throw new Error(candidate.issues.join('\n'));
  plan.record.facts = readCurrentFacts({ input, record: plan.record, catalog: candidate });
  appendStatusDecision(plan.record, 'resume', input.reason);
  writePlan({ input, markdown: plan.markdown, record: plan.record });
}

function readPlan(input) {
  const absolutePath = resolveTacticalPlanPath(input.repoRoot, input.planPath);
  const markdown = readFileSync(absolutePath, 'utf8');
  return { absolutePath, markdown, record: parseAdaptivePlanRecord(markdown, input.planPath) };
}

function writePlan(transaction) {
  const { input, markdown, record, removals = [] } = transaction;
  const planPath = resolveTacticalPlanPath(input.repoRoot, input.planPath);
  writeFileTransaction({
    replacements: [
      {
        path: planPath,
        content: replaceAdaptivePlanRecord(markdown, record, input.planPath),
      },
    ],
    removals,
  });
}

function requireActivePlan(plan, command) {
  if (plan.record.status !== 'active') throw new Error(`${command} requires an active plan`);
}

function appendStatusDecision(record, decision, reason) {
  record.materialDecisions.push({
    date: new Date().toISOString().slice(0, 10),
    decision,
    summary: reason,
  });
}

function readCurrentFacts({
  input, record, includeUnassigned = false, catalog = readAdaptivePlanCatalog(input.repoRoot),
}) {
  const changes = readChangedPaths(input.repoRoot, input.base);
  return computePlanFacts({
    repoRoot: input.repoRoot,
    base: input.base,
    changes: selectPlanChanges({
      repoRoot: input.repoRoot,
      base: input.base,
      changes,
      catalog,
      planPath: input.planPath,
      includeUnassigned,
    }),
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
  return evidence;
}

function toDraftPath(repoRoot, planId) {
  if (typeof planId !== 'string' || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(planId)) {
    throw new Error('record.planId must use lowercase letters, digits, and single hyphens');
  }
  return path.join(resolvePlanAdaptationOutputRoot(repoRoot), `${planId}.draft.json`);
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
