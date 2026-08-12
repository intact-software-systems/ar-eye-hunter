import { computeCheckpointDigest } from './adaptive-plan-record.mjs';

const decisions = new Set(['continue', 'amend', 'consolidate', 'stop']);

export function validateCheckpoint(checkpoint, record) {
  const issues = [];
  if (!isRecord(checkpoint)) {
    return ['checkpoint must contain the five required judgments'];
  }
  for (const field of ['outcome', 'learning', 'structure']) {
    if (typeof checkpoint[field] !== 'string' || checkpoint[field].trim() === '') {
      issues.push(`checkpoint.${field} must be a non-empty judgment`);
    }
  }
  if (!decisions.has(checkpoint.decision)) {
    issues.push('checkpoint.decision must be continue, amend, consolidate, or stop');
  }
  validateNextSlices(issues, checkpoint.nextSlices);
  validateContinueDecision(issues, checkpoint, record);
  validateConsolidationDecision(issues, checkpoint, record);
  return issues;
}

export function hasConsolidationDecision(record) {
  return record.materialDecisions?.some((entry) => entry?.decision === 'consolidate') ?? false;
}

function validateNextSlices(issues, nextSlices) {
  if (!Array.isArray(nextSlices)) {
    issues.push('checkpoint.nextSlices must be an array');
    return;
  }
  if (nextSlices.length > 2) {
    issues.push('checkpoint.nextSlices must contain at most two concrete slices');
  }
  if (nextSlices.some((slice) => typeof slice !== 'string' || slice.trim() === '')) {
    issues.push('checkpoint.nextSlices must contain only concrete non-empty slice names');
  }
  if (new Set(nextSlices).size !== nextSlices.length) {
    issues.push('checkpoint.nextSlices must not contain duplicate slices');
  }
}

function validateContinueDecision(issues, checkpoint, record) {
  if (checkpoint.decision !== 'continue' || !Array.isArray(checkpoint.nextSlices)) {
    return;
  }
  const failures = record.freshStructuralReview?.failures;
  if (!Array.isArray(failures)) {
    return;
  }
  const unrecoverableFailure =
    record.freshStructuralReview?.status === 'failed' ||
    failures.some(
      (failure) =>
        ['navigation', 'ownership'].includes(failure?.kind) && failure.recoverable === false,
    );
  if (unrecoverableFailure) {
    issues.push(
      'continue is invalid while an unrecoverable navigation or ownership failure is known',
    );
  }
  const deepensFailure = failures.some((failure) => {
    if (!['navigation', 'ownership'].includes(failure?.kind)) {
      return false;
    }
    return failure.deepenedBySlices?.some((slice) => checkpoint.nextSlices.includes(slice));
  });
  if (deepensFailure) {
    issues.push('continue cannot deepen a known navigation or ownership failure');
  }
}

function validateConsolidationDecision(issues, checkpoint, record) {
  const consolidated = hasConsolidationDecision(record);
  const persistedCurrentConsolidation = record.materialDecisions?.some(
    (entry) =>
      entry?.decision === 'consolidate' &&
      entry.checkpointDigest === computeCheckpointDigest(checkpoint),
  );
  const coldNavigationFailed = record.coldNavigationEvidence?.status === 'failed';
  const consolidationDecisionIndex = record.coldNavigationEvidence?.consolidationDecisionIndex;
  const referencedConsolidation =
    Number.isInteger(consolidationDecisionIndex) &&
    record.materialDecisions?.[consolidationDecisionIndex]?.decision === 'consolidate';
  if (consolidated && coldNavigationFailed) {
    if (!referencedConsolidation) {
      issues.push('failed cold navigation must reference the prior consolidation decision');
    }
    if (checkpoint.decision !== 'stop' || checkpoint.nextSlices?.length !== 0) {
      issues.push(
        'failed cold navigation after consolidation requires decision stop and no next slices',
      );
    }
    return;
  }
  if (checkpoint.decision !== 'consolidate') {
    return;
  }
  if (consolidated && !persistedCurrentConsolidation) {
    issues.push('only one autonomous consolidation slice is allowed');
  }
  if (checkpoint.nextSlices?.length !== 1) {
    issues.push('consolidate must replace the next feature slice with one consolidation slice');
  }
}

function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
