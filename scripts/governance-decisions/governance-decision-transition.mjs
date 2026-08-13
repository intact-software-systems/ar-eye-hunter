import { createHash } from 'node:crypto';

import {
  computeCheckpointDigest,
  parseAdaptivePlanRecord,
  replaceAdaptivePlanRecord,
  validateAdaptivePlanRecord,
} from '../plan-adaptation/adaptive-plan-record.mjs';
import { toActivePlanRegistry } from '../plan-adaptation/active-plan-registry.mjs';
import { validateCheckpoint } from '../plan-adaptation/adaptive-plan-policy.mjs';
import { computePlanFactsFromTree } from '../plan-adaptation/plan-change-facts.mjs';
import { computeSha256 } from './canonical-json.mjs';
import {
  computeGovernanceDecisionId,
  decodeGovernanceDecisionRequest,
} from './governance-decision-request.mjs';
import {
  toContentIdentity,
  toGovernanceDecisionReceiptPath,
} from './governance-decision-receipt.mjs';

export function computeGovernanceDecisionTransition(transitionInput) {
  const request = decodeGovernanceDecisionRequest(transitionInput.request);
  validateSnapshot(request, transitionInput.snapshot);
  const entriesByPath = toEntriesByPath(transitionInput.snapshot.entries);
  const receiptPath = toGovernanceDecisionReceiptPath(computeGovernanceDecisionId(request));
  if (entriesByPath.has(receiptPath)) {
    throw new Error('decision receipt path already exists');
  }
  const targetEntry = readTargetEntry(entriesByPath, request.target.planPath);
  validateTargetIdentity(request, targetEntry);

  const computed = computeOperation({
    request,
    snapshot: transitionInput.snapshot,
    entriesByPath,
    targetEntry,
    readBlob: transitionInput.readBlob,
    readChanges: transitionInput.readChanges,
    readSnapshot: transitionInput.readSnapshot,
  });
  return toTransition({
    request,
    snapshot: transitionInput.snapshot,
    entriesByPath,
    receiptPath,
    ...computed,
  });
}

function computeOperation(operationInput) {
  if (operationInput.request.operation === 'plan.repair') {
    return computePlanRepair(operationInput);
  }
  if (operationInput.request.operation === 'plan.supersede') {
    return computePlanSupersession(operationInput);
  }
  if (operationInput.request.operation === 'plan.quarantine') {
    return computePlanRemoval(operationInput, 'unknown', true);
  }
  const acceptanceStatus =
    operationInput.request.operation === 'plan.cancel' ? 'not-achieved' : 'admin-attested';
  return computePlanRemoval(operationInput, acceptanceStatus, false);
}

function computePlanRepair(operationInput) {
  const { record, issues } = readGovernedPlan(operationInput);
  const repairedRecord = structuredClone(record);
  repairedRecord.checkpoint = structuredClone(operationInput.request.payload.checkpoint);
  repairedRecord.completedSlicesSinceCheckpoint = [];
  const replacementIssues = validateCheckpoint(repairedRecord.checkpoint, repairedRecord).map(
    (issue) => `replacement checkpoint: ${issue}`,
  );
  repairedRecord.materialDecisions = [
    ...repairedRecord.materialDecisions,
    toMaterialDecision(
      operationInput.snapshot.commitDate,
      repairedRecord.checkpoint,
      operationInput.request,
    ),
  ];

  const candidateEntries = replaceEntryContent(
    operationInput.entriesByPath,
    operationInput.request.target.planPath,
    replaceAdaptivePlanRecord(
      operationInput.targetEntry.content,
      repairedRecord,
      operationInput.request.target.planPath,
    ),
  );
  const factInput = {
    entries: [...candidateEntries.values()].sort(compareEntries),
    record: structuredClone(repairedRecord),
    planPath: operationInput.request.target.planPath,
    expectedHeadOid: operationInput.request.expectedHeadOid,
  };
  repairedRecord.facts = computeFactsFromSnapshotReader(operationInput, factInput);
  const repairedMarkdown = replaceAdaptivePlanRecord(
    operationInput.targetEntry.content,
    repairedRecord,
    operationInput.request.target.planPath,
  );
  candidateEntries.set(
    operationInput.request.target.planPath,
    toEntry(operationInput.request.target.planPath, repairedMarkdown),
  );
  const registry = computeRegistry(candidateEntries, false, operationInput.request.target.planPath);
  candidateEntries.set('plans/README.md', toEntry('plans/README.md', registry));
  return {
    candidateEntries,
    result: { acceptanceStatus: 'repaired' },
    bypassedInvariants: [...issues, ...replacementIssues],
  };
}

function computePlanRemoval(operationInput, acceptanceStatus, tolerateInvalidPlans) {
  let issues = [];
  if (!tolerateInvalidPlans) {
    issues = readGovernedPlan(operationInput).issues;
  }
  const candidateEntries = cloneEntries(operationInput.entriesByPath);
  candidateEntries.delete(operationInput.request.target.planPath);
  const registry = computeRegistry(candidateEntries, tolerateInvalidPlans);
  candidateEntries.set('plans/README.md', toEntry('plans/README.md', registry));
  return {
    candidateEntries,
    result: { acceptanceStatus },
    bypassedInvariants: issues,
  };
}

function computePlanSupersession(operationInput) {
  const predecessor = readGovernedPlan(operationInput);
  if (operationInput.entriesByPath.has(operationInput.request.payload.successorPlanPath)) {
    throw new Error('successorPlanPath already exists at expected head');
  }
  if (typeof operationInput.readBlob !== 'function') {
    throw new Error('plan.supersede requires the injected blob content reader');
  }
  const blobRead = operationInput.readBlob(operationInput.request.payload.successorPlanBlobOid);
  const successorMarkdown = typeof blobRead === 'string' ? blobRead : blobRead?.content;
  if (typeof successorMarkdown !== 'string') {
    throw new Error('successor blob reader must return UTF-8 plan content');
  }
  if (toGitBlobOid(successorMarkdown) !== operationInput.request.payload.successorPlanBlobOid) {
    throw new Error('successor content does not match successorPlanBlobOid');
  }
  const successorRecord = parseAdaptivePlanRecord(
    successorMarkdown,
    operationInput.request.payload.successorPlanPath,
  );
  const successorIssues = [
    ...validateAdaptivePlanRecord(successorRecord),
    ...validateCheckpoint(successorRecord.checkpoint, successorRecord),
  ];
  if (successorIssues.length > 0) {
    throw new Error(`successor plan is invalid:\n${successorIssues.join('\n')}`);
  }
  const candidateEntries = cloneEntries(operationInput.entriesByPath);
  candidateEntries.delete(operationInput.request.target.planPath);
  candidateEntries.set(
    operationInput.request.payload.successorPlanPath,
    toEntry(operationInput.request.payload.successorPlanPath, successorMarkdown),
  );
  candidateEntries.set(
    'plans/README.md',
    toEntry('plans/README.md', computeRegistry(candidateEntries, false)),
  );
  return {
    candidateEntries,
    result: { acceptanceStatus: 'transferred' },
    bypassedInvariants: predecessor.issues,
  };
}

function readGovernedPlan(operationInput) {
  const record = parseAdaptivePlanRecord(
    operationInput.targetEntry.content,
    operationInput.request.target.planPath,
  );
  if (
    record.version !== 1 ||
    typeof record.planId !== 'string' ||
    !/^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(record.planId) ||
    record.status !== 'active'
  ) {
    throw new Error('target plan must have valid immutable schema identity and active status');
  }
  const schemaIssues = validateAdaptivePlanRecord(record);
  if (schemaIssues.length > 0) {
    throw new Error(
      `target plan contains non-bypassable schema defects: ${schemaIssues.join('; ')}`,
    );
  }
  return {
    record,
    issues: validateCheckpoint(record.checkpoint, record)
      .map((issue) => `existing checkpoint: ${issue}`)
      .sort(compareText),
  };
}

function computeRegistry(entriesByPath, tolerateInvalidPlans, governedBypassPath) {
  const activePlans = [];
  for (const entry of entriesByPath.values()) {
    if (
      !/^plans\/[a-z0-9]+(?:-[a-z0-9]+)*\.md$/u.test(entry.path) ||
      !entry.content.includes('```plan-adaptation-v1')
    ) {
      continue;
    }
    try {
      const record = parseAdaptivePlanRecord(entry.content, entry.path);
      const issues = validateAdaptivePlanRecord(record);
      if (issues.length > 0 && entry.path !== governedBypassPath) {
        throw new Error(issues.join('\n'));
      }
      if (record.status === 'active') {
        activePlans.push({ planPath: entry.path, record });
      }
    } catch (error) {
      if (!tolerateInvalidPlans) {
        throw error;
      }
    }
  }
  activePlans.sort((left, right) => compareText(left.record.planId, right.record.planId));
  return toActivePlanRegistry(activePlans);
}

function toTransition(transitionInput) {
  const additions = [];
  const deletions = [];
  const stateChanges = [];
  const allPaths = new Set([
    ...transitionInput.entriesByPath.keys(),
    ...transitionInput.candidateEntries.keys(),
  ]);
  for (const changedPath of [...allPaths].sort(compareText)) {
    const before = transitionInput.entriesByPath.get(changedPath);
    const after = transitionInput.candidateEntries.get(changedPath);
    if (before?.mode === after?.mode && before?.content === after?.content) {
      continue;
    }
    if (after === undefined) {
      deletions.push(changedPath);
    } else {
      additions.push({ path: changedPath, content: after.content });
    }
    stateChanges.push({
      path: changedPath,
      before: before ? toContentIdentity(before.content, before.blobOid) : null,
      after: after ? toContentIdentity(after.content, after.blobOid) : null,
    });
  }
  return {
    decisionId: computeGovernanceDecisionId(transitionInput.request),
    receiptPath: transitionInput.receiptPath,
    result: transitionInput.result,
    bypassedInvariants: [...new Set(transitionInput.bypassedInvariants)].sort(compareText),
    additions,
    deletions,
    stateChanges,
  };
}

function validateSnapshot(request, snapshot) {
  if (snapshot?.headOid !== request.expectedHeadOid) {
    throw new Error('expected head does not match repository snapshot');
  }
  if (!Array.isArray(snapshot.entries)) {
    throw new Error('repository snapshot entries must be an array');
  }
}

function toEntriesByPath(entries) {
  const entriesByPath = new Map();
  for (const entry of entries) {
    if (
      typeof entry?.path !== 'string' ||
      typeof entry.content !== 'string' ||
      !['100644', '100755', '120000'].includes(entry.mode) ||
      !/^[0-9a-f]{40}$/u.test(entry.blobOid ?? '') ||
      entriesByPath.has(entry.path)
    ) {
      throw new Error('repository snapshot contains an invalid or duplicate entry');
    }
    entriesByPath.set(entry.path, { ...entry });
  }
  return entriesByPath;
}

function readTargetEntry(entriesByPath, planPath) {
  const entry = entriesByPath.get(planPath);
  if (!entry) {
    throw new Error('target plan does not exist at expected head');
  }
  if (entry.mode === '120000') {
    throw new Error('target plan must not be a symbolic link');
  }
  if (!['100644', '100755'].includes(entry.mode)) {
    throw new Error('target plan must be a regular file');
  }
  return entry;
}

function validateTargetIdentity(request, targetEntry) {
  if (request.operation === 'plan.quarantine') {
    if (targetEntry.blobOid !== request.target.planBlobOid) {
      throw new Error('target plan blob identity does not match expected head');
    }
    return;
  }
  if (computeSha256(targetEntry.content) !== request.target.planDigest) {
    throw new Error('target plan digest does not match expected head');
  }
}

function toMaterialDecision(date, checkpoint, request) {
  return {
    date,
    decision: checkpoint.decision,
    summary: checkpoint.outcome,
    governanceDecisionId: computeGovernanceDecisionId(request),
    ...(checkpoint.decision === 'consolidate'
      ? { checkpointDigest: computeCheckpointDigest(checkpoint) }
      : {}),
  };
}

function computeFactsFromSnapshotReader(operationInput, factInput) {
  if (
    typeof operationInput.readSnapshot !== 'function' ||
    typeof operationInput.readChanges !== 'function'
  ) {
    throw new Error('plan.repair requires injected base snapshot and change readers');
  }
  const baseOid = factInput.record.facts?.diffBase;
  if (typeof baseOid !== 'string' || baseOid === '') {
    throw new Error('plan.repair target must identify its facts diffBase');
  }
  const baseSnapshot = operationInput.readSnapshot(baseOid);
  if (baseSnapshot?.headOid !== baseOid || !Array.isArray(baseSnapshot.entries)) {
    throw new Error('base snapshot reader returned the wrong repository tree');
  }
  const changes = operationInput.readChanges(baseOid, operationInput.request.expectedHeadOid);
  if (!Array.isArray(changes)) {
    throw new Error('change reader returned malformed repository changes');
  }
  const candidateChanges = replaceCanonicalChangesForCandidatePaths({
    changes,
    baseEntries: baseSnapshot.entries,
    candidateEntries: factInput.entries,
    candidatePaths: [factInput.planPath],
  });
  return computePlanFactsFromTree({
    baseOid,
    baseEntries: baseSnapshot.entries,
    entries: factInput.entries,
    changes: candidateChanges,
    record: factInput.record,
    planPath: factInput.planPath,
  });
}

function replaceCanonicalChangesForCandidatePaths(input) {
  const candidatePathSet = new Set(input.candidatePaths);
  const baseByPath = new Map(input.baseEntries.map((entry) => [entry.path, entry]));
  const candidateByPath = new Map(input.candidateEntries.map((entry) => [entry.path, entry]));
  const retained = [];
  for (const change of input.changes) {
    if (candidatePathSet.has(change.path)) {
      if (change.status.startsWith('R') && !candidatePathSet.has(change.oldPath)) {
        retained.push({
          status: 'D',
          path: change.oldPath,
          oldMode: change.oldMode,
          newMode: '000000',
        });
      }
      continue;
    }
    if (candidatePathSet.has(change.oldPath)) {
      retained.push({
        status: 'A',
        path: change.path,
        oldMode: '000000',
        newMode: change.newMode,
      });
      continue;
    }
    retained.push(change);
  }
  for (const candidatePath of input.candidatePaths) {
    const base = baseByPath.get(candidatePath);
    const candidate = candidateByPath.get(candidatePath);
    if (base?.mode === candidate?.mode && base?.blobOid === candidate?.blobOid) {
      continue;
    }
    retained.push({
      status: base ? (candidate ? 'M' : 'D') : 'A',
      path: candidatePath,
      oldMode: base?.mode ?? '000000',
      newMode: candidate?.mode ?? '000000',
    });
  }
  return retained.sort((left, right) => compareText(left.path, right.path));
}

function replaceEntryContent(entriesByPath, entryPath, content) {
  const entries = cloneEntries(entriesByPath);
  entries.set(entryPath, toEntry(entryPath, content));
  return entries;
}

function cloneEntries(entriesByPath) {
  return new Map([...entriesByPath].map(([entryPath, entry]) => [entryPath, { ...entry }]));
}

function toEntry(entryPath, content) {
  return { path: entryPath, mode: '100644', blobOid: toGitBlobOid(content), content };
}

function toGitBlobOid(content) {
  const bytes = Buffer.from(content);
  return createHash('sha1').update(`blob ${bytes.byteLength}\0`).update(bytes).digest('hex');
}

function compareEntries(left, right) {
  return compareText(left.path, right.path);
}

function compareText(left, right) {
  return Buffer.compare(Buffer.from(left), Buffer.from(right));
}
