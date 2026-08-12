import { createHash } from 'node:crypto';

const recordPattern = /```plan-adaptation-v1\s*\n([\s\S]*?)\n```/gu;

export function parseAdaptivePlanRecord(markdown, sourceName = 'adaptive plan') {
  const matches = [...markdown.matchAll(recordPattern)];
  if (matches.length !== 1) {
    throw new Error(`${sourceName} must contain exactly one plan-adaptation-v1 block`);
  }

  try {
    return JSON.parse(matches[0][1]);
  } catch (error) {
    throw new Error(`${sourceName} contains invalid JSON: ${toError(error).message}`);
  }
}

export function replaceAdaptivePlanRecord(markdown, record, sourceName = 'adaptive plan') {
  parseAdaptivePlanRecord(markdown, sourceName);
  const replacement = `\`\`\`plan-adaptation-v1\n${JSON.stringify(record, null, 2)}\n\`\`\``;
  return markdown.replace(recordPattern, replacement);
}

export function computeAdaptivePlanRecordDigest(record) {
  return createHash('sha256').update(JSON.stringify(record)).digest('hex');
}

export function computeCheckpointDigest(checkpoint) {
  return createHash('sha256')
    .update(
      JSON.stringify({
        outcome: checkpoint.outcome,
        learning: checkpoint.learning,
        structure: checkpoint.structure,
        decision: checkpoint.decision,
        nextSlices: checkpoint.nextSlices,
      }),
    )
    .digest('hex');
}

export function validateAdaptivePlanRecord(record) {
  const issues = [];
  if (!isRecord(record) || record.version !== 1) {
    return ['record.version must be 1'];
  }
  if (typeof record.planId !== 'string' || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(record.planId)) {
    issues.push('record.planId must use lowercase letters, digits, and single hyphens');
  }
  if (record.status !== 'active') {
    issues.push('record.status must be active');
  }
  requireText(issues, record.goal, 'record.goal');
  requireTextArray(issues, record.acceptanceCriteria, 'record.acceptanceCriteria');
  validateCapabilities(issues, record.capabilities);
  validateTextArray(
    issues,
    record.completedSlicesSinceCheckpoint,
    'record.completedSlicesSinceCheckpoint',
  );
  validateFacts(issues, record.facts);
  if (!isRecord(record.checkpoint)) {
    issues.push('record.checkpoint must be an object');
  }
  validateStructuralDispositions(issues, record.structuralDispositions);
  validateStructuralReview(issues, record.freshStructuralReview);
  validateColdNavigationEvidence(issues, record.coldNavigationEvidence);
  validateMaterialDecisions(issues, record.materialDecisions);
  return issues;
}

function validateCapabilities(issues, capabilities) {
  if (!Array.isArray(capabilities) || capabilities.length === 0) {
    issues.push('record.capabilities must contain at least one capability');
    return;
  }
  for (const [index, capability] of capabilities.entries()) {
    if (!isRecord(capability)) {
      issues.push(`record.capabilities[${index}] must be an object`);
      continue;
    }
    const kind = capability.kind ?? 'code';
    if (!['code', 'guidance'].includes(kind)) {
      issues.push(`record.capabilities[${index}].kind must be code or guidance`);
      continue;
    }
    requireText(issues, capability.owner, `record.capabilities[${index}].owner`);
    validateCapabilityActivation(issues, capability, index);
    if (kind === 'guidance') {
      validateGuidanceCapability(issues, capability, index);
    } else {
      validateCodeCapability(issues, capability, index);
    }
  }
  validatePlannedCapabilityOwnership(issues, capabilities);
}

function validatePlannedCapabilityOwnership(issues, capabilities) {
  for (const [leftIndex, leftCapability] of capabilities.entries()) {
    for (const rightCapability of capabilities.slice(leftIndex + 1)) {
      if (!isPlannedCapability(leftCapability) && !isPlannedCapability(rightCapability)) {
        continue;
      }
      const plannedCapability = isPlannedCapability(leftCapability)
        ? leftCapability
        : rightCapability;
      const otherCapability =
        plannedCapability === leftCapability ? rightCapability : leftCapability;
      for (const plannedRoot of topologyRoots(plannedCapability)) {
        for (const otherRoot of topologyRoots(otherCapability)) {
          if (rootsOverlap(plannedRoot, otherRoot)) {
            const otherState = isPlannedCapability(otherCapability) ? 'planned' : 'active';
            issues.push(
              `planned capability ${plannedCapability.owner} root ${plannedRoot} overlaps ` +
                `${otherState} capability ${otherCapability.owner} root ${otherRoot}`,
            );
          }
        }
      }
    }
  }
}

function topologyRoots(capability) {
  if (!isRecord(capability)) {
    return [];
  }
  return capability.kind === 'guidance'
    ? [capability.skillRoot, capability.contractTestRoot, capability.evaluationRoot].filter(
        (root) => typeof root === 'string',
      )
    : [capability.root, capability.testRoot].filter((root) => typeof root === 'string');
}

function rootsOverlap(left, right) {
  return left === right || left.startsWith(`${right}/`) || right.startsWith(`${left}/`);
}

function validateCapabilityActivation(issues, capability, index) {
  if (capability.activation === undefined) {
    return;
  }
  if (
    !isRecord(capability.activation) ||
    capability.activation.state !== 'planned' ||
    !hasExactKeys(capability.activation, ['state', 'slice'])
  ) {
    issues.push(
      `record.capabilities[${index}].activation must be omitted or exactly planned with one slice`,
    );
    return;
  }
  if (
    typeof capability.activation.slice !== 'string' ||
    capability.activation.slice.trim() === ''
  ) {
    issues.push(
      `record.capabilities[${index}].activation.slice must be a non-empty string ` +
        'for planned capabilities',
    );
  }
}

export function isPlannedCapability(capability) {
  return capability?.activation?.state === 'planned';
}

function validateCodeCapability(issues, capability, index) {
  for (const field of ['root', 'entry', 'testRoot', 'focusedCommand']) {
    requireText(issues, capability[field], `record.capabilities[${index}].${field}`);
  }
  for (const field of ['root', 'entry', 'testRoot']) {
    if (!isSafeRepositoryPath(capability[field])) {
      issues.push(`record.capabilities[${index}].${field} must be a safe repository-relative path`);
    }
  }
  if (capability.navigationMap !== null && !isSafeRepositoryPath(capability.navigationMap)) {
    const name = `record.capabilities[${index}].navigationMap`;
    issues.push(`${name} must be null or a safe repository-relative path`);
  }
  if (
    capability.factContracts !== undefined &&
    (!Array.isArray(capability.factContracts) ||
      capability.factContracts.some((factContract) => !isSafeRepositoryPath(factContract)))
  ) {
    issues.push(
      `record.capabilities[${index}].factContracts must contain safe ` +
        'repository-relative paths',
    );
  }
  if (
    capability.controlFlowFamilies !== undefined &&
    (!Array.isArray(capability.controlFlowFamilies) ||
      capability.controlFlowFamilies.length === 0 ||
      capability.controlFlowFamilies.some(
        (family) => typeof family !== 'string' || family.trim() === '',
      ) ||
      new Set(capability.controlFlowFamilies).size !== capability.controlFlowFamilies.length)
  ) {
    issues.push(
      `record.capabilities[${index}].controlFlowFamilies must contain unique ` +
        'non-empty strings',
    );
  }
}

function validateGuidanceCapability(issues, capability, index) {
  for (const field of ['skillRoot', 'skillEntry', 'contractTestRoot', 'focusedCommand']) {
    requireText(issues, capability[field], `record.capabilities[${index}].${field}`);
  }
  for (const field of ['skillRoot', 'skillEntry', 'contractTestRoot']) {
    if (!isSafeRepositoryPath(capability[field])) {
      issues.push(`record.capabilities[${index}].${field} must be a safe repository-relative path`);
    }
  }
  if (
    capability.evaluationRoot !== undefined &&
    capability.evaluationRoot !== null &&
    !isSafeRepositoryPath(capability.evaluationRoot)
  ) {
    issues.push(
      `record.capabilities[${index}].evaluationRoot must be null or a safe ` +
        'repository-relative path',
    );
  }
  if (
    !Array.isArray(capability.contractPaths) ||
    capability.contractPaths.some((contractPath) => !isSafeRepositoryPath(contractPath))
  ) {
    issues.push(
      `record.capabilities[${index}].contractPaths must contain safe repository-relative paths`,
    );
  }
  if (capability.skillEntry !== `${capability.skillRoot}/SKILL.md`) {
    issues.push(
      `record.capabilities[${index}].skillEntry must be the SKILL.md entry inside its skillRoot`,
    );
  }
  if (
    ['root', 'entry', 'testRoot', 'navigationMap', 'factContracts', 'controlFlowFamilies'].some(
      (field) => field in capability,
    )
  ) {
    issues.push(
      `record.capabilities[${index}] guidance capability must not declare code-only fields`,
    );
  }
}

function validateFacts(issues, facts) {
  if (!isRecord(facts)) {
    issues.push('record.facts must be an object');
    return;
  }
  requireText(issues, facts.diffBase, 'record.facts.diffBase');
  if (
    facts.affectedCodeDigest !== null &&
    !/^[a-f0-9]{64}$/u.test(facts.affectedCodeDigest ?? '')
  ) {
    issues.push('record.facts.affectedCodeDigest must be null or a SHA-256 digest');
  }
  validateTextArray(issues, facts.computedTriggers, 'record.facts.computedTriggers');
  if (!Array.isArray(facts.undeclaredChangedPaths)) {
    issues.push('record.facts.undeclaredChangedPaths must be an array');
  } else if (facts.undeclaredChangedPaths.some((value) => !isSafeRepositoryPath(value))) {
    issues.push('record.facts.undeclaredChangedPaths must contain safe repository-relative paths');
  }
}

function validateStructuralDispositions(issues, dispositions) {
  if (!Array.isArray(dispositions)) {
    issues.push('record.structuralDispositions must be an array');
    return;
  }
  for (const [index, disposition] of dispositions.entries()) {
    const name = `record.structuralDispositions[${index}]`;
    if (!isRecord(disposition)) {
      issues.push(`${name} must be an object`);
      continue;
    }
    if (!['ownership-contract', 'current-fact'].includes(disposition.kind)) {
      issues.push(`${name}.kind must be ownership-contract or current-fact`);
      continue;
    }
    requireText(issues, disposition.target, `${name}.target`);
    if (!['keep', 'split', 'move', 'consolidate'].includes(disposition.disposition)) {
      issues.push(`${name}.disposition must be keep, split, move, or consolidate`);
    }
    requireText(issues, disposition.rationale, `${name}.rationale`);
    if (disposition.kind === 'current-fact') {
      requireText(issues, disposition.ruleId, `${name}.ruleId`);
      if (!isSafeRepositoryPath(disposition.target)) {
        issues.push(`${name}.target must be a safe repository-relative path`);
      }
      if (
        disposition.identity !== null &&
        (typeof disposition.identity !== 'string' || disposition.identity.trim() === '')
      ) {
        issues.push(`${name}.identity must be null or a non-empty string`);
      }
      if (!Number.isInteger(disposition.magnitude) || disposition.magnitude < 0) {
        issues.push(`${name}.magnitude must be a non-negative integer`);
      }
      if (!/^[a-f0-9]{64}$/u.test(disposition.affectedCodeDigest ?? '')) {
        issues.push(`${name}.affectedCodeDigest must be a SHA-256 digest`);
      }
    }
  }
}

function validateStructuralReview(issues, review) {
  if (review === null) {
    return;
  }
  if (!isRecord(review) || !['complete', 'failed'].includes(review.status)) {
    issues.push('record.freshStructuralReview must be null or have status complete or failed');
    return;
  }
  if (!Array.isArray(review.failures)) {
    issues.push('record.freshStructuralReview.failures must be an array');
    return;
  }
  for (const [index, failure] of review.failures.entries()) {
    if (!isRecord(failure) || !['navigation', 'ownership'].includes(failure.kind)) {
      issues.push(
        `record.freshStructuralReview.failures[${index}].kind must be navigation or ownership`,
      );
      continue;
    }
    requireText(issues, failure.summary, `record.freshStructuralReview.failures[${index}].summary`);
    if (typeof failure.recoverable !== 'boolean') {
      issues.push(`record.freshStructuralReview.failures[${index}].recoverable must be boolean`);
    }
    validateTextArray(
      issues,
      failure.deepenedBySlices,
      `record.freshStructuralReview.failures[${index}].deepenedBySlices`,
    );
  }
}

function validateColdNavigationEvidence(issues, evidence) {
  if (evidence === null) {
    return;
  }
  if (!isRecord(evidence) || !['passed', 'failed'].includes(evidence.status)) {
    issues.push('record.coldNavigationEvidence must be null or have status passed or failed');
    return;
  }
  requireText(issues, evidence.summary, 'record.coldNavigationEvidence.summary');
  if (!Array.isArray(evidence.probes) || evidence.probes.length === 0) {
    issues.push('record.coldNavigationEvidence.probes must be a non-empty array');
  } else {
    for (const [index, probe] of evidence.probes.entries()) {
      requireText(
        issues,
        probe?.capabilityOwner,
        `record.coldNavigationEvidence.probes[${index}].capabilityOwner`,
      );
      requireText(issues, probe?.symbol, `record.coldNavigationEvidence.probes[${index}].symbol`);
      if (!isSafeRepositoryPath(probe?.path)) {
        issues.push(
          `record.coldNavigationEvidence.probes[${index}].path must be a safe ` +
            'repository-relative path',
        );
      }
    }
  }
  if (
    evidence.consolidationDecisionIndex !== undefined &&
    (!Number.isInteger(evidence.consolidationDecisionIndex) ||
      evidence.consolidationDecisionIndex < 0)
  ) {
    issues.push(
      'record.coldNavigationEvidence.consolidationDecisionIndex must be a non-negative integer',
    );
  }
}

function validateMaterialDecisions(issues, decisions) {
  if (!Array.isArray(decisions)) {
    issues.push('record.materialDecisions must be an array');
    return;
  }
  for (const [index, decision] of decisions.entries()) {
    if (!isRecord(decision)) {
      issues.push(`record.materialDecisions[${index}] must be an object`);
      continue;
    }
    if (typeof decision.date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/u.test(decision.date)) {
      issues.push(`record.materialDecisions[${index}].date must use YYYY-MM-DD`);
    }
    requireText(issues, decision.decision, `record.materialDecisions[${index}].decision`);
    if (decision.summary !== undefined) {
      requireText(issues, decision.summary, `record.materialDecisions[${index}].summary`);
    }
    if (
      decision.decision === 'consolidate' &&
      (typeof decision.checkpointDigest !== 'string' ||
        !/^[0-9a-f]{64}$/u.test(decision.checkpointDigest))
    ) {
      issues.push(
        `record.materialDecisions[${index}].checkpointDigest must bind the consolidate checkpoint`,
      );
    }
  }
}

function requireTextArray(issues, value, name) {
  if (!Array.isArray(value) || value.length === 0) {
    issues.push(`${name} must be a non-empty array`);
    return;
  }
  if (value.some((item) => typeof item !== 'string' || item.trim() === '')) {
    issues.push(`${name} must contain only non-empty strings`);
  }
}

function validateTextArray(issues, value, name) {
  if (!Array.isArray(value)) {
    issues.push(`${name} must be an array`);
    return;
  }
  if (value.some((item) => typeof item !== 'string' || item.trim() === '')) {
    issues.push(`${name} must contain only non-empty strings`);
  }
}

export function isSafeRepositoryPath(value) {
  if (typeof value !== 'string' || value === '' || value.includes('\\') || value.includes('\0')) {
    return false;
  }
  if (
    value.startsWith('/') ||
    value.endsWith('/') ||
    value.split('/').some((part) => part === '' || part === '.' || part === '..')
  ) {
    return false;
  }
  return true;
}

function requireText(issues, value, name) {
  if (typeof value !== 'string' || value.trim() === '') {
    issues.push(`${name} must be a non-empty string`);
  }
}

function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasExactKeys(value, expectedKeys) {
  const keys = Object.keys(value);
  return keys.length === expectedKeys.length && expectedKeys.every((key) => keys.includes(key));
}

function toError(value) {
  return value instanceof Error ? value : new Error(String(value));
}
