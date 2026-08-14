import { computeSha256, toCanonicalJson } from './canonical-json.mjs';

const commonKeys = [
  'schemaVersion',
  'operation',
  'repository',
  'defaultBranch',
  'expectedHeadOid',
  'force',
  'reason',
  'target',
  'payload',
];
const operationNames = new Set([
  'plan.repair',
  'plan.cancel',
  'plan.supersede',
  'plan.complete',
  'plan.quarantine',
  'gate.accept-deviation',
  'exception.decide',
]);
const exceptionKinds = new Set([
  'production-legacy',
  'repository-structure',
  'repository-code-style',
  'test-structure-coupling',
]);
const planDigestPattern = /^[0-9a-f]{64}$/u;
const gitObjectIdPattern = /^[0-9a-f]{40}$/u;
const planPathPattern = /^plans\/[a-z0-9]+(?:-[a-z0-9]+)*\.md$/u;

export function decodeGovernanceDecisionRequest(value) {
  requireExactKeys(value, commonKeys, 'request');
  if (value.schemaVersion !== 'governance-decision-request-v1') {
    throw new Error('schemaVersion must be governance-decision-request-v1');
  }
  if (!operationNames.has(value.operation)) {
    throw new Error('operation must be a supported governance decision');
  }
  if (value.repository !== 'intact-software-systems/ar-eye-hunter') {
    throw new Error('repository must be intact-software-systems/ar-eye-hunter');
  }
  if (value.defaultBranch !== 'main') {
    throw new Error('defaultBranch must be main');
  }
  requireGitObjectId(value.expectedHeadOid, 'expectedHeadOid');
  if (value.force !== true) {
    throw new Error('force must be true');
  }
  if (typeof value.reason !== 'string' || value.reason.trim() === '') {
    throw new Error('reason must be a non-empty string');
  }

  validateOperationShape(value.operation, value.target, value.payload);
  return JSON.parse(
    toCanonicalJson(Object.fromEntries(commonKeys.map((key) => [key, value[key]]))),
  );
}

export function computeGovernanceDecisionId(request) {
  return computeSha256(toCanonicalJson(request));
}

export function isDirectPlanPath(planPath) {
  return typeof planPath === 'string' && planPathPattern.test(planPath);
}

function validateOperationShape(operation, target, payload) {
  if (operation === 'gate.accept-deviation') {
    validateGateDeviation(target, payload);
    return;
  }
  if (operation === 'exception.decide') {
    validateExceptionDecision(target, payload);
    return;
  }
  if (operation === 'plan.quarantine') {
    requireExactKeys(target, ['planPath', 'planBlobOid'], `${operation} target`);
    requirePlanPath(target.planPath);
    requireGitObjectId(target.planBlobOid, 'planBlobOid');
    requireEmptyPayload(payload, operation);
    return;
  }

  requireExactKeys(target, ['planPath', 'planDigest'], `${operation} target`);
  requirePlanPath(target.planPath);
  if (typeof target.planDigest !== 'string' || !planDigestPattern.test(target.planDigest)) {
    throw new Error('planDigest must be a SHA-256 digest');
  }
  if (operation === 'plan.repair') {
    requireExactKeys(payload, ['checkpoint'], `${operation} payload`);
    validateCheckpoint(payload.checkpoint);
    return;
  }
  if (operation === 'plan.supersede') {
    requireExactKeys(
      payload,
      ['successorPlanPath', 'successorPlanBlobOid'],
      `${operation} payload`,
    );
    requirePlanPath(payload.successorPlanPath, 'successorPlanPath');
    requireGitObjectId(payload.successorPlanBlobOid, 'successorPlanBlobOid');
    if (payload.successorPlanPath === target.planPath) {
      throw new Error('successorPlanPath must differ from the predecessor planPath');
    }
    return;
  }
  requireEmptyPayload(payload, operation);
}

function validateGateDeviation(target, payload) {
  requireExactKeys(
    target,
    ['workflowRunId', 'runAttempt', 'gateName', 'candidateSha'],
    'gate.accept-deviation target',
  );
  requirePositiveInteger(target.workflowRunId, 'workflowRunId');
  requirePositiveInteger(target.runAttempt, 'runAttempt');
  requireNonEmptyText(target.gateName, 'gateName');
  requireGitObjectId(target.candidateSha, 'candidateSha');
  requireEmptyPayload(payload, 'gate.accept-deviation');
}

function validateExceptionDecision(target, payload) {
  if (target?.action === 'revoke') {
    requireExactKeys(target, ['action', 'priorDecisionId'], 'exception.decide revoke target');
    requireSha256(target.priorDecisionId, 'priorDecisionId');
    requireExactKeys(payload, [], 'exception.decide revoke payload');
    return;
  }
  requireExactKeys(
    target,
    ['action', 'exceptionKind', 'candidateHead', 'projectionSha256'],
    'exception.decide approve target',
  );
  if (target.action !== 'approve') {
    throw new Error('exception.decide target.action must be approve or revoke');
  }
  if (!exceptionKinds.has(target.exceptionKind)) {
    throw new Error('exceptionKind must identify one supported governance exception');
  }
  requireGitObjectId(target.candidateHead, 'candidateHead');
  requireSha256(target.projectionSha256, 'projectionSha256');
  requireExactKeys(payload, ['projection'], 'exception.decide approve payload');
  validateExceptionProjection(target.exceptionKind, target.candidateHead, payload.projection);
  if (computeSha256(toCanonicalJson(payload.projection)) !== target.projectionSha256) {
    throw new Error('projectionSha256 must match the canonical projection');
  }
}

function validateExceptionProjection(exceptionKind, candidateHead, projection) {
  if (exceptionKind === 'repository-structure') {
    requireExactKeys(
      projection,
      ['ruleId', 'target', 'owner', 'reviewOrRemovalCondition'],
      'repository-structure projection',
    );
    if (projection.ruleId !== 'topology.singleton-subtree') {
      throw new Error('repository-structure projection ruleId is unsupported');
    }
    requireConfinedPath(projection.target, 'repository-structure projection target');
    requireNonEmptyText(projection.owner, 'repository-structure projection owner');
    requireNonEmptyText(
      projection.reviewOrRemovalCondition,
      'repository-structure projection reviewOrRemovalCondition',
    );
    return;
  }
  if (exceptionKind === 'production-legacy') {
    validateProductionLegacyProjection(projection, candidateHead);
    return;
  }
  if (exceptionKind === 'repository-code-style') {
    validateCodeStyleProjection(projection, candidateHead);
    return;
  }
  validateTestCouplingProjection(projection, candidateHead);
}

function validateProductionLegacyProjection(projection, candidateHead) {
  requireExactKeys(
    projection,
    ['retainedLedgerProjection', 'ledgerSha256', 'approvedProductionSha', 'candidateHead'],
    'production-legacy projection',
  );
  requireSha256(projection.ledgerSha256, 'production-legacy projection ledgerSha256');
  requireGitObjectId(
    projection.approvedProductionSha,
    'production-legacy projection approvedProductionSha',
  );
  requireMatchingCandidateHead(projection.candidateHead, candidateHead, 'production-legacy');
  if (
    !Array.isArray(projection.retainedLedgerProjection) ||
    projection.retainedLedgerProjection.length === 0
  ) {
    throw new Error('production-legacy retainedLedgerProjection must be a non-empty array');
  }
  for (const [index, item] of projection.retainedLedgerProjection.entries()) {
    const name = `production-legacy retainedLedgerProjection[${index}]`;
    requireExactKeys(
      item,
      [
        'id',
        'path',
        'symbol',
        'classification',
        'disposition',
        'purpose',
        'consumerDependency',
        'unsafeRemovalReason',
        'minimization',
        'canonicalOwner',
        'compatibilityTests',
        'owner',
        'removalCondition',
        'approvedProductionSha',
      ],
      name,
    );
    for (const field of Object.keys(item)) {
      requireNonEmptyText(item[field], `${name}.${field}`);
    }
    if (item.classification !== 'legacy') {
      throw new Error(`${name}.classification must be legacy`);
    }
    if (item.disposition !== 'retained-pending-human-approval') {
      throw new Error(`${name}.disposition must be retained-pending-human-approval`);
    }
    requireConfinedPath(item.path, `${name}.path`);
    if (item.approvedProductionSha !== projection.approvedProductionSha) {
      throw new Error(`${name}.approvedProductionSha must match the projection`);
    }
  }
  const identifiers = projection.retainedLedgerProjection.map((item) => item.id);
  if (
    new Set(identifiers).size !== identifiers.length ||
    identifiers.some((identifier, index) => index > 0 && identifiers[index - 1] >= identifier)
  ) {
    throw new Error('production-legacy retainedLedgerProjection must be sorted with unique IDs');
  }
  if (productionLegacyLedgerHash(projection.retainedLedgerProjection) !== projection.ledgerSha256) {
    throw new Error(
      'production-legacy projection ledgerSha256 must match retainedLedgerProjection',
    );
  }
}

function productionLegacyLedgerHash(items) {
  const itemFields = [
    'id',
    'path',
    'symbol',
    'classification',
    'disposition',
    'rationale',
    'purpose',
    'consumerDependency',
    'unsafeRemovalReason',
    'minimization',
    'canonicalOwner',
    'compatibilityTests',
    'owner',
    'removalCondition',
    'approvedProductionSha',
  ];
  const nativeProjection = items.map((item) =>
    Object.fromEntries(
      itemFields.filter((field) => item[field] !== undefined).map((field) => [field, item[field]]),
    ),
  );
  return computeSha256(JSON.stringify(nativeProjection));
}

function validateCodeStyleProjection(projection, candidateHead) {
  requireExactKeys(
    projection,
    ['rule', 'path', 'symbol', 'magnitude', 'candidateHead'],
    'repository-code-style projection',
  );
  requireNonEmptyText(projection.rule, 'repository-code-style projection rule');
  requireConfinedPath(projection.path, 'repository-code-style projection path');
  if (
    projection.symbol !== null &&
    (typeof projection.symbol !== 'string' || projection.symbol.trim() === '')
  ) {
    throw new Error('repository-code-style projection symbol must be null or non-empty');
  }
  if (!Number.isSafeInteger(projection.magnitude) || projection.magnitude < 0) {
    throw new Error('repository-code-style magnitude must be a non-negative integer');
  }
  requireMatchingCandidateHead(projection.candidateHead, candidateHead, 'repository-code-style');
}

function validateTestCouplingProjection(projection, candidateHead) {
  requireExactKeys(
    projection,
    ['candidate', 'semanticContract', 'disposition', 'candidateHead'],
    'test-structure-coupling projection',
  );
  requireExactKeys(
    projection.candidate,
    ['id', 'path', 'line', 'column', 'kind'],
    'test-structure-coupling candidate',
  );
  for (const field of ['id', 'kind']) {
    requireNonEmptyText(projection.candidate[field], `test-structure-coupling candidate.${field}`);
  }
  requireConfinedPath(projection.candidate.path, 'test-structure-coupling candidate.path');
  requirePositiveInteger(projection.candidate.line, 'test-structure-coupling candidate.line');
  requirePositiveInteger(projection.candidate.column, 'test-structure-coupling candidate.column');
  validateSemanticContract(projection.semanticContract);
  validateTestCouplingDisposition(projection.disposition, projection.semanticContract);
  requireMatchingCandidateHead(projection.candidateHead, candidateHead, 'test-structure-coupling');
}

function validateSemanticContract(contract) {
  const optionalKeys = contract?.sharedCoverageGroup === undefined ? [] : ['sharedCoverageGroup'];
  requireExactKeys(
    contract,
    ['id', 'domain', 'owner', 'summary', 'semanticCoverage', 'coverageRelation', ...optionalKeys],
    'test-structure-coupling semanticContract',
  );
  for (const field of Object.keys(contract)) {
    requireNonEmptyText(contract[field], `test-structure-coupling semanticContract.${field}`);
  }
}

function validateTestCouplingDisposition(disposition, semanticContract) {
  if (disposition?.kind === 'durable-boundary') {
    requireExactKeys(
      disposition,
      ['kind', 'boundary', 'owner', 'rationale', 'semanticCoverage'],
      'test-structure-coupling durable disposition',
    );
    if (!['public', 'security', 'compatibility'].includes(disposition.boundary)) {
      throw new Error('test-structure-coupling durable disposition boundary is unsupported');
    }
  } else if (disposition?.kind === 'temporary-ratchet') {
    requireExactKeys(
      disposition,
      ['kind', 'owner', 'rationale', 'semanticCoverage', 'removalCondition'],
      'test-structure-coupling temporary disposition',
    );
  } else {
    throw new Error('test-structure-coupling disposition kind is unsupported');
  }
  for (const field of Object.keys(disposition)) {
    requireNonEmptyText(disposition[field], `test-structure-coupling disposition.${field}`);
  }
  if (disposition.semanticCoverage !== semanticContract.semanticCoverage) {
    throw new Error('test-structure-coupling disposition must match semantic contract coverage');
  }
}

function requireMatchingCandidateHead(actual, expected, exceptionKind) {
  requireGitObjectId(actual, `${exceptionKind} projection candidateHead`);
  if (actual !== expected) {
    throw new Error(`${exceptionKind} projection candidateHead must equal target candidateHead`);
  }
}

function validateCheckpoint(checkpoint) {
  const keys = ['outcome', 'learning', 'structure', 'decision', 'nextSlices'];
  requireExactKeys(checkpoint, keys, 'plan.repair checkpoint');
  for (const key of ['outcome', 'learning', 'structure']) {
    if (typeof checkpoint[key] !== 'string' || checkpoint[key].trim() === '') {
      throw new Error(`plan.repair checkpoint.${key} must be a non-empty string`);
    }
  }
  if (!['continue', 'amend', 'consolidate', 'stop'].includes(checkpoint.decision)) {
    throw new Error('plan.repair checkpoint.decision is invalid');
  }
  if (
    !Array.isArray(checkpoint.nextSlices) ||
    checkpoint.nextSlices.length > 2 ||
    checkpoint.nextSlices.some((slice) => typeof slice !== 'string' || slice.trim() === '') ||
    new Set(checkpoint.nextSlices).size !== checkpoint.nextSlices.length
  ) {
    throw new Error('plan.repair checkpoint.nextSlices must contain at most two unique slices');
  }
}

function requireEmptyPayload(payload, operation) {
  requireExactKeys(payload, [], `${operation} payload`);
}

function requirePlanPath(planPath, name = 'planPath') {
  if (!isDirectPlanPath(planPath) || planPath === 'plans/README.md') {
    throw new Error(`${name} must identify a direct plans/<kebab>.md file`);
  }
}

function requireGitObjectId(value, name) {
  if (typeof value !== 'string' || !gitObjectIdPattern.test(value)) {
    throw new Error(`${name} must be 40 lowercase hexadecimal characters`);
  }
}

function requireSha256(value, name) {
  if (typeof value !== 'string' || !planDigestPattern.test(value)) {
    throw new Error(`${name} must be a SHA-256 digest`);
  }
}

function requirePositiveInteger(value, name) {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
}

function requireNonEmptyText(value, name) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`${name} must be a non-empty string`);
  }
}

function requireConfinedPath(value, name) {
  if (
    typeof value !== 'string' ||
    value === '' ||
    value !== value.replaceAll('\\', '/') ||
    value.startsWith('/') ||
    value.split('/').includes('..')
  ) {
    throw new Error(`${name} must be a confined repository-relative path`);
  }
}

function requireExactKeys(value, expectedKeys, name) {
  if (!isRecord(value)) {
    throw new Error(`${name} must be an object`);
  }
  const actualKeys = Object.keys(value);
  const expected = new Set(expectedKeys);
  const unsupported = actualKeys.filter((key) => !expected.has(key)).sort();
  const missing = expectedKeys.filter((key) => !actualKeys.includes(key));
  if (name === 'request' && unsupported.length > 0) {
    throw new Error(`unsupported request keys: ${unsupported.join(', ')}`);
  }
  if (unsupported.length > 0 || missing.length > 0) {
    if (expectedKeys.length === 0) {
      throw new Error(`${name} must be empty`);
    }
    throw new Error(`${name} must contain exactly: ${expectedKeys.join(', ')}`);
  }
}

function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
