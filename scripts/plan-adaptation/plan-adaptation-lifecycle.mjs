import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import {
  computeAdaptivePlanRecordDigest,
  parseAdaptivePlanRecord,
  replaceAdaptivePlanRecord,
  validateAdaptivePlanRecord,
} from './adaptive-plan-record.mjs';
import { hasConsolidationDecision, validateCheckpoint } from './adaptive-plan-policy.mjs';
import {
  readActivePlans,
  toActivePlanRegistry,
  writeActivePlanRegistry,
} from './active-plan-registry.mjs';
import { computePlanFacts, readChangedPaths } from './plan-change-facts.mjs';

export function initAdaptivePlan(input) {
  const plan = readPlan(input);
  validateRecordAndCheckpoint(plan.record);
  plan.record.facts = readCurrentFacts(input, plan.record);
  writePlan(input, plan.markdown, plan.record);
  writeActivePlanRegistry(input.repoRoot);
}

export function completeAdaptivePlanSlice(input) {
  const plan = readPlan(input);
  validateRecordAndCheckpoint(plan.record);
  if (plan.record.completedSlicesSinceCheckpoint.includes(input.slice)) {
    throw new Error(`slice ${input.slice} is already complete since the prior checkpoint`);
  }
  plan.record.completedSlicesSinceCheckpoint.push(input.slice);
  plan.record.facts = readCurrentFacts(input, plan.record);
  writePlan(input, plan.markdown, plan.record);
  writeActivePlanRegistry(input.repoRoot);
}

export function prepareAdaptivePlan(input) {
  const plan = readPlan(input);
  validateRecordAndCheckpoint(plan.record);
  plan.record.facts = readCurrentFacts(input, plan.record);
  plan.record.checkpoint = {
    outcome: '',
    learning: '',
    structure: '',
    decision: '',
    nextSlices: [],
  };
  const draftPath = toDraftPath(input.repoRoot, plan.record.planId);
  mkdirSync(path.dirname(draftPath), { recursive: true });
  writeFileSync(
    draftPath,
    `${JSON.stringify({ version: 1, planPath: input.planPath, record: plan.record }, null, 2)}\n`,
  );
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
  validateRecordAndCheckpoint(draft.record);
  const currentFacts = readCurrentFacts(input, draft.record);
  if (JSON.stringify(currentFacts) !== JSON.stringify(draft.record.facts)) {
    throw new Error('draft facts are stale; run prepare again');
  }
  appendMaterialDecision(draft.record);
  draft.record.completedSlicesSinceCheckpoint = [];
  writePlan(input, plan.markdown, draft.record);
  rmSync(draftPath);
  writeActivePlanRegistry(input.repoRoot);
}

export function checkAdaptivePlans(input) {
  const activePlans = readActivePlans(input.repoRoot);
  const issues = [];
  for (const activePlan of activePlans) {
    issues.push(...validateAdaptivePlanRecord(activePlan.record));
    issues.push(...validateCheckpoint(activePlan.record.checkpoint, activePlan.record));
    const currentFacts = readCurrentFacts(
      {
        ...input,
        planPath: activePlan.planPath,
        base: activePlan.record.facts.diffBase ?? input.base,
      },
      activePlan.record,
    );
    if (currentFacts.affectedCodeDigest !== activePlan.record.facts.affectedCodeDigest) {
      issues.push(`${activePlan.planPath} affected-code digest is stale`);
    }
    if (
      JSON.stringify(currentFacts.undeclaredChangedPaths) !==
      JSON.stringify(activePlan.record.facts.undeclaredChangedPaths)
    ) {
      issues.push(`${activePlan.planPath} undeclared changed paths are stale`);
    }
  }
  const registryPath = path.join(input.repoRoot, 'plans/README.md');
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
  validateFinalEvidence(input, plan.record);
  const absolutePlanPath = path.resolve(input.repoRoot, input.planPath);
  const plansRoot = path.resolve(input.repoRoot, 'plans');
  if (path.dirname(absolutePlanPath) !== plansRoot) {
    throw new Error('close may delete only a tactical plan directly under plans/');
  }
  rmSync(absolutePlanPath);
  writeActivePlanRegistry(input.repoRoot);
}

function readPlan(input) {
  const absolutePath = path.join(input.repoRoot, input.planPath);
  const markdown = readFileSync(absolutePath, 'utf8');
  return { markdown, record: parseAdaptivePlanRecord(markdown, input.planPath) };
}

function writePlan(input, markdown, record) {
  writeFileSync(
    path.join(input.repoRoot, input.planPath),
    replaceAdaptivePlanRecord(markdown, record, input.planPath),
  );
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
  if (record.checkpoint.decision === 'consolidate' && hasConsolidationDecision(record)) {
    return;
  }
  record.materialDecisions.push({
    date: new Date().toISOString().slice(0, 10),
    decision: record.checkpoint.decision,
    summary: record.checkpoint.outcome,
  });
}

function validateFinalEvidence(input, record) {
  const evidencePath = input.finalPrEvidence
    ? path.resolve(input.repoRoot, input.finalPrEvidence)
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
  return path.join(repoRoot, '.plan-adaptation', `${planId}.draft.json`);
}

function toError(value) {
  return value instanceof Error ? value : new Error(String(value));
}
