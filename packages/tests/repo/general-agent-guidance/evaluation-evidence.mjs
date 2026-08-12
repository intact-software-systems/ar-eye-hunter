import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const digestPattern = /^[a-f0-9]{64}$/u;
const treeIdentityPattern = /^git-tree:[a-f0-9]{40}$/u;

export function validateEvidenceLedger({ repoRoot, contractPath, ledgerPath }) {
  const issues = [];
  const contractAbsolutePath = resolveArtifact(repoRoot, contractPath, issues, 'contract');
  const ledgerAbsolutePath = resolveArtifact(repoRoot, ledgerPath, issues, 'ledger');
  if (!contractAbsolutePath || !ledgerAbsolutePath) {
    return issues;
  }

  const contract = readJson(contractAbsolutePath, issues, 'contract');
  const ledger = readJson(ledgerAbsolutePath, issues, 'ledger');
  if (!contract || !ledger) {
    return issues;
  }

  expectEqual(
    issues,
    ledger.schemaVersion,
    contract.evidenceContract?.schemaVersion,
    'ledger schemaVersion',
  );
  expectEqual(
    issues,
    ledger.contractDigest,
    sha256(readFileSync(contractAbsolutePath)),
    'contract digest',
  );
  validateRuntimeGuidance(repoRoot, ledger.runtimeGuidance, issues);

  const contractVariants = new Map(
    (contract.variants ?? []).map((variant) => [variant.id, variant]),
  );
  const evidenceVariants = new Map((ledger.variants ?? []).map((variant) => [variant.id, variant]));
  expectEqual(
    issues,
    [...evidenceVariants.keys()].sort(),
    [...contractVariants.keys()].sort(),
    'variant IDs',
  );
  for (const [variantId, evidenceVariant] of evidenceVariants) {
    validateVariant(
      repoRoot,
      contract,
      contractVariants.get(variantId),
      evidenceVariant,
      ledger.runtimeGuidance,
      issues,
    );
  }

  const runIds = new Set();
  const freshAgentIds = new Set();
  const completedCountByVariant = new Map();
  for (const run of ledger.runs ?? []) {
    if (runIds.has(run.runId)) {
      issues.push(`duplicate runId: ${String(run.runId)}`);
    }
    runIds.add(run.runId);
    if (run.status === 'completed') {
      validateCompletedRun(
        repoRoot,
        contract,
        evidenceVariants.get(run.variant),
        run,
        freshAgentIds,
        issues,
      );
      completedCountByVariant.set(run.variant, (completedCountByVariant.get(run.variant) ?? 0) + 1);
    } else {
      validateNonCanonicalRun(run, contract, issues);
    }
  }
  for (const variantId of contractVariants.keys()) {
    expectEqual(
      issues,
      completedCountByVariant.get(variantId) ?? 0,
      contract.repetitionsPerVariant,
      `${variantId} completed repetitions`,
    );
    for (let repetition = 1; repetition <= contract.repetitionsPerVariant; repetition += 1) {
      const expectedRunId = `${variantId}-${repetition}`;
      if (!runIds.has(expectedRunId)) {
        issues.push(`absent canonical run ID: ${expectedRunId}`);
      }
    }
  }
  return issues;
}

function validateRuntimeGuidance(repoRoot, runtimeGuidance, issues) {
  if (!runtimeGuidance || typeof runtimeGuidance !== 'object') {
    issues.push('runtimeGuidance is required');
    return;
  }
  validateArtifactDigest(
    repoRoot,
    runtimeGuidance.artifact,
    runtimeGuidance.digest,
    issues,
    'runtime guidance',
  );
}

function validateVariant(
  repoRoot,
  contract,
  contractVariant,
  evidenceVariant,
  runtimeGuidance,
  issues,
) {
  if (!contractVariant) {
    issues.push(`undeclared variant: ${String(evidenceVariant.id)}`);
    return;
  }
  if (!treeIdentityPattern.test(evidenceVariant.treeIdentity ?? '')) {
    issues.push(`${evidenceVariant.id}: invalid treeIdentity`);
  }
  if (contractVariant.treeSource?.kind) {
    expectEqual(
      issues,
      evidenceVariant.treeSource?.kind,
      contractVariant.treeSource.kind,
      `${evidenceVariant.id}: tree source kind`,
    );
    try {
      expectEqual(
        issues,
        evidenceVariant.treeIdentity,
        resolveTreeIdentity(repoRoot, evidenceVariant.treeSource),
        `${evidenceVariant.id}: resolved tree identity`,
      );
    } catch (error) {
      issues.push(`${evidenceVariant.id}: cannot resolve tree identity: ${String(error)}`);
    }
  }
  const expectedAutomaticIds = (contract.automaticInputs ?? []).map(({ id }) => id).sort();
  expectEqual(
    issues,
    (evidenceVariant.automaticInputs ?? []).map(({ id }) => id).sort(),
    expectedAutomaticIds,
    `${evidenceVariant.id}: automatic input IDs`,
  );
  const expectedExplicitSources = [...(contractVariant.explicitInputs ?? [])].sort();
  expectEqual(
    issues,
    (evidenceVariant.explicitInputs ?? []).map(({ source }) => source).sort(),
    expectedExplicitSources,
    `${evidenceVariant.id}: explicit input sources`,
  );
  for (const input of [
    ...(evidenceVariant.automaticInputs ?? []),
    ...(evidenceVariant.explicitInputs ?? []),
  ]) {
    validateInputDigest(repoRoot, input, issues, `${evidenceVariant.id}: ${String(input.id)}`);
  }
  const runtimeInput = (evidenceVariant.automaticInputs ?? []).find(
    ({ id }) => id === 'codex-runtime-guidance',
  );
  expectEqual(
    issues,
    runtimeInput?.digest,
    runtimeGuidance?.digest,
    `${evidenceVariant.id}: runtime guidance digest`,
  );
  expectEqual(
    issues,
    evidenceVariant.inputBundleDigest,
    digestCanonical({
      automaticInputs: evidenceVariant.automaticInputs,
      explicitInputs: evidenceVariant.explicitInputs,
    }),
    `${evidenceVariant.id}: input bundle digest`,
  );
}

function validateCompletedRun(repoRoot, contract, variant, run, freshAgentIds, issues) {
  const label = String(run.runId);
  for (const field of contract.evidenceContract?.requiredPerRunFields ?? []) {
    if (!Object.hasOwn(run, field)) {
      issues.push(`${label}: missing field ${field}`);
    }
  }
  if (!variant) {
    issues.push(`${label}: undeclared variant ${String(run.variant)}`);
    return;
  }
  expectEqual(issues, run.treeIdentity, variant.treeIdentity, `${label}: treeIdentity`);
  expectEqual(issues, run.automaticInputs, variant.automaticInputs, `${label}: automatic inputs`);
  expectEqual(issues, run.explicitInputs, variant.explicitInputs, `${label}: explicit inputs`);
  expectEqual(
    issues,
    run.inputBundleDigest,
    variant.inputBundleDigest,
    `${label}: input bundle digest`,
  );
  const promptDigest = sha256(contract.scenario?.prompt ?? '');
  expectEqual(issues, run.promptDigest, promptDigest, `${label}: prompt digest`);
  if (!digestPattern.test(run.runtimePreambleDigest ?? '')) {
    issues.push(`${label}: invalid runtime preamble digest`);
  }
  validateArtifactDigest(
    repoRoot,
    run.runtimePreambleArtifact,
    run.runtimePreambleDigest,
    issues,
    `${label}: runtime preamble`,
  );
  expectEqual(
    issues,
    run.exactInvocationDigest,
    digestCanonical({
      inputBundleDigest: run.inputBundleDigest,
      promptDigest: run.promptDigest,
      runtimePreambleDigest: run.runtimePreambleDigest,
      treeIdentity: run.treeIdentity,
      model: run.model,
      reasoningEffort: run.reasoningEffort,
      forkTurns: run.forkTurns,
      singleShot: run.singleShot,
      freshAgentId: run.freshAgentId,
    }),
    `${label}: exact invocation digest`,
  );
  for (const field of ['model', 'reasoningEffort', 'forkTurns', 'singleShot']) {
    expectEqual(issues, run[field], contract.execution?.[field], `${label}: ${field}`);
  }
  if (typeof run.freshAgentId !== 'string' || run.freshAgentId.length === 0) {
    issues.push(`${label}: freshAgentId is required`);
  } else if (freshAgentIds.has(run.freshAgentId)) {
    issues.push(`${label}: duplicate freshAgentId`);
  } else {
    freshAgentIds.add(run.freshAgentId);
  }
  validateTimes(run, issues, label);
  validateArtifactDigest(
    repoRoot,
    run.rawOutputArtifact,
    run.rawOutputDigest,
    issues,
    `${label}: raw output`,
  );
  validateArtifactDigest(repoRoot, run.scoreArtifact, run.scoreDigest, issues, `${label}: score`);
  validateScore(repoRoot, contract, run, issues);
}

function validateNonCanonicalRun(run, contract, issues) {
  const allowed = contract.evidenceContract?.statuses ?? [];
  if (!allowed.includes(run.status)) {
    issues.push(`${String(run.runId)}: invalid status ${String(run.status)}`);
  }
  if (typeof run.reason !== 'string' || run.reason.length === 0) {
    issues.push(`${String(run.runId)}: excluded/aborted reason is required`);
  }
  if (!Object.hasOwn(run, 'availableEvidence')) {
    issues.push(`${String(run.runId)}: availableEvidence accounting is required`);
  }
}

function validateTimes(run, issues, label) {
  const startedAt = Date.parse(run.startedAt);
  const completedAt = Date.parse(run.completedAt);
  if (!Number.isFinite(startedAt) || !Number.isFinite(completedAt) || completedAt < startedAt) {
    issues.push(`${label}: invalid start/completion timestamps`);
  }
}

function validateScore(repoRoot, contract, run, issues) {
  const scorePath = resolveArtifact(repoRoot, run.scoreArtifact, issues, `${run.runId}: score`);
  if (!scorePath) {
    return;
  }
  const score = readJson(scorePath, issues, `${run.runId}: score`);
  if (!score) {
    return;
  }
  expectEqual(issues, score.runId, run.runId, `${run.runId}: score runId`);
  expectEqual(
    issues,
    Object.keys(score.dimensions ?? {}).sort(),
    (contract.requiredDimensions ?? []).map(({ id }) => id).sort(),
    `${run.runId}: score dimension IDs`,
  );
  for (const [dimensionId, value] of Object.entries(score.dimensions ?? {})) {
    if (typeof value !== 'boolean') {
      issues.push(`${run.runId}: score ${dimensionId} must be boolean`);
    }
  }
}

function validateArtifactDigest(repoRoot, artifact, expectedDigest, issues, label) {
  if (!digestPattern.test(expectedDigest ?? '')) {
    issues.push(`${label}: invalid digest`);
    return;
  }
  const artifactPath = resolveArtifact(repoRoot, artifact, issues, label);
  if (!artifactPath) {
    return;
  }
  expectEqual(issues, sha256(readFileSync(artifactPath)), expectedDigest, `${label} digest`);
}

function validateInputDigest(repoRoot, input, issues, label) {
  if (!digestPattern.test(input.digest ?? '')) {
    issues.push(`${label}: invalid digest`);
    return;
  }
  if (input.gitObject) {
    try {
      expectEqual(
        issues,
        sha256(readGitObject(repoRoot, input.gitObject)),
        input.digest,
        `${label} digest`,
      );
    } catch (error) {
      issues.push(`${label}: cannot read Git object: ${String(error)}`);
    }
    return;
  }
  if (input.absoluteArtifact) {
    validateAbsoluteArtifactDigest(input.absoluteArtifact, input.digest, issues, label);
    return;
  }
  validateArtifactDigest(repoRoot, input.artifact, input.digest, issues, label);
}

function validateAbsoluteArtifactDigest(artifact, expectedDigest, issues, label) {
  if (typeof artifact !== 'string' || !path.isAbsolute(artifact)) {
    issues.push(`${label}: absolute artifact path is required`);
    return;
  }
  try {
    expectEqual(issues, sha256(readFileSync(artifact)), expectedDigest, `${label} digest`);
  } catch {
    issues.push(`${label}: absolute artifact does not exist: ${artifact}`);
  }
}

function resolveArtifact(repoRoot, artifact, issues, label) {
  if (typeof artifact !== 'string' || artifact.length === 0) {
    issues.push(`${label}: artifact path is required`);
    return undefined;
  }
  const absoluteRoot = path.resolve(repoRoot);
  const absolutePath = path.resolve(absoluteRoot, artifact);
  if (absolutePath !== absoluteRoot && !absolutePath.startsWith(`${absoluteRoot}${path.sep}`)) {
    issues.push(`${label}: artifact escapes repository root`);
    return undefined;
  }
  try {
    readFileSync(absolutePath);
    return absolutePath;
  } catch {
    issues.push(`${label}: artifact does not exist: ${artifact}`);
    return undefined;
  }
}

function readJson(absolutePath, issues, label) {
  try {
    return JSON.parse(readFileSync(absolutePath, 'utf8'));
  } catch {
    issues.push(`${label}: invalid JSON`);
    return undefined;
  }
}

function expectEqual(issues, actual, expected, label) {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    issues.push(
      `${label}: expected ${JSON.stringify(expected)}, received ${JSON.stringify(actual)}`,
    );
  }
}

export function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

export function readGitObject(repoRoot, gitObject) {
  const revision = gitObject?.revision;
  const repositoryPath = gitObject?.path;
  if (!/^[a-f0-9]{40}$/u.test(revision ?? '')) {
    throw new Error('Git revision must be a full commit ID');
  }
  if (
    typeof repositoryPath !== 'string' ||
    repositoryPath.length === 0 ||
    repositoryPath.startsWith('/') ||
    repositoryPath.includes('..') ||
    repositoryPath.includes(':') ||
    repositoryPath.includes('\n')
  ) {
    throw new Error('Git object path is unsafe');
  }
  return execFileSync('git', ['show', `${revision}:${repositoryPath}`], {
    cwd: repoRoot,
    encoding: 'utf8',
    maxBuffer: 10 * 1024 * 1024,
  });
}

export function resolveTreeIdentity(repoRoot, treeSource) {
  if (treeSource?.kind === 'immutable-head-tree') {
    const revision = treeSource.revision;
    if (!/^[a-f0-9]{40}$/u.test(revision ?? '')) {
      throw new Error('Immutable tree source requires a full commit ID');
    }
    const tree = execFileSync('git', ['rev-parse', `${revision}^{tree}`], {
      cwd: repoRoot,
      encoding: 'utf8',
    }).trim();
    return `git-tree:${tree}`;
  }
  if (treeSource?.kind === 'full-worktree-git-tree') {
    return `git-tree:${computeFullWorktreeTree(repoRoot)}`;
  }
  throw new Error(`Unsupported tree source kind: ${String(treeSource?.kind)}`);
}

export function computeFullWorktreeTree(repoRoot) {
  const temporaryRoot = mkdtempSync(path.join(os.tmpdir(), 'guidance-evidence-index-'));
  const indexPath = path.join(temporaryRoot, 'index');
  const environment = { ...process.env, GIT_INDEX_FILE: indexPath };
  try {
    execFileSync('git', ['read-tree', 'HEAD'], { cwd: repoRoot, env: environment });
    execFileSync('git', ['add', '-A', '--', '.'], { cwd: repoRoot, env: environment });
    return execFileSync('git', ['write-tree'], {
      cwd: repoRoot,
      env: environment,
      encoding: 'utf8',
    }).trim();
  } finally {
    rmSync(temporaryRoot, { recursive: true, force: true });
  }
}

export function digestCanonical(value) {
  return sha256(JSON.stringify(sortValue(value)));
}

function sortValue(value) {
  if (Array.isArray(value)) {
    return value.map(sortValue);
  }
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, child]) => [key, sortValue(child)]),
    );
  }
  return value;
}
