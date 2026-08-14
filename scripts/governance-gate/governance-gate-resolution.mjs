const gitObjectIdPattern = /^[0-9a-f]{40}$/u;
const decisionIdPattern = /^[0-9a-f]{64}$/u;

export function resolveGovernanceGateStatus(input) {
  if (input.localStatus === 'passed') {
    return { status: 'passed', underlyingStatus: 'passed', decisionId: '' };
  }
  if (input.localStatus !== 'failed') {
    throw new Error('local governance gate status must be passed or failed');
  }
  validateCurrentGate(input);
  if (!Array.isArray(input.deviations)) {
    throw new Error('governance gate deviations must be verified decisions');
  }
  const applicable = input.deviations.filter(
    (deviation) =>
      isExactDeviation(deviation) &&
      deviation.workflowRunId === input.currentRunId &&
      deviation.runAttempt < input.currentRunAttempt &&
      deviation.gateName === input.gateName &&
      deviation.candidateSha === input.candidateSha &&
      deviation.status === 'accepted-deviation' &&
      deviation.underlyingStatus === 'failed',
  );
  if (applicable.length !== 1) {
    throw new Error('failed governance gate has no exact accepted deviation');
  }
  return {
    status: 'accepted-deviation',
    underlyingStatus: 'failed',
    decisionId: applicable[0].decisionId,
  };
}

function validateCurrentGate(input) {
  if (!gitObjectIdPattern.test(input.candidateSha ?? '')) {
    throw new Error('governance gate candidate must be an exact Git object ID');
  }
  if (!Number.isSafeInteger(input.currentRunId) || input.currentRunId <= 0) {
    throw new Error('governance gate run ID must be a positive integer');
  }
  if (!Number.isSafeInteger(input.currentRunAttempt) || input.currentRunAttempt <= 0) {
    throw new Error('governance gate run attempt must be a positive integer');
  }
  if (typeof input.gateName !== 'string' || input.gateName.trim() === '') {
    throw new Error('governance gate name must be non-empty');
  }
}

function isExactDeviation(deviation) {
  return (
    typeof deviation === 'object' &&
    deviation !== null &&
    !Array.isArray(deviation) &&
    decisionIdPattern.test(deviation.decisionId ?? '') &&
    Number.isSafeInteger(deviation.workflowRunId) &&
    Number.isSafeInteger(deviation.runAttempt) &&
    typeof deviation.gateName === 'string' &&
    gitObjectIdPattern.test(deviation.candidateSha ?? '')
  );
}
