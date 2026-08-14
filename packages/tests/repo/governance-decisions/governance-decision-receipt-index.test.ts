import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  computeSha256,
  toCanonicalJson,
} from '../../../../scripts/governance-decisions/canonical-json.mjs';
import { verifyGovernanceDecisionCommit } from '../../../../scripts/governance-decisions/governance-decision-commit-verification.mjs';
import {
  indexGovernanceDecisionReceipts,
  readTrustedGovernanceDecisionIndex,
  resolveGovernanceExceptionDecisions,
  resolveGovernanceGateDeviations,
} from '../../../../scripts/governance-decisions/governance-decision-receipt-index.mjs';
import {
  computeGovernanceDecisionId,
  decodeGovernanceDecisionRequest,
} from '../../../../scripts/governance-decisions/governance-decision-request.mjs';
import {
  createGovernanceDecisionReceipt,
  serializeGovernanceDecisionReceipt,
} from '../../../../scripts/governance-decisions/governance-decision-receipt.mjs';
import { computeGovernanceDecisionTransition } from '../../../../scripts/governance-decisions/governance-decision-transition.mjs';
import { readGitRepositorySnapshot } from '../../../../scripts/governance-decisions/git-repository-snapshot.mjs';

const candidateHead = '2'.repeat(40);
const fixtureRoots: string[] = [];

afterEach(() => {
  for (const fixtureRoot of fixtureRoots.splice(0)) {
    rmSync(fixtureRoot, { recursive: true, force: true });
  }
});

describe('trusted governance decision receipt index', () => {
  it('isolates malformed receipts while retaining an exact applicable approval', () => {
    const approval = approvalEvidence('repository-structure', structureProjection());
    const indexed = indexGovernanceDecisionReceipts([
      approval,
      {
        decisionId: 'f'.repeat(64),
        path: `governance/decisions/${'f'.repeat(64)}.json`,
        commitOid: '9'.repeat(40),
        content: '{not-json}\n',
      },
    ]);

    expect(
      resolveGovernanceExceptionDecisions(indexed, {
        exceptionKind: 'repository-structure',
        candidateHead,
      }),
    ).toEqual([
      {
        decisionId: approval.decisionId,
        projection: structureProjection(),
      },
    ]);
    expect(indexed.issues).toHaveLength(1);
    expect(indexed.issues[0]).toContain('contains invalid JSON');
  });

  it('applies chronological revocation to exactly one prior approval', () => {
    const first = approvalEvidence('repository-structure', structureProjection());
    const second = approvalEvidence('repository-structure', {
      ...structureProjection(),
      target: 'packages/example/other-singleton',
    });
    const revoke = revocationEvidence(first.decisionId, '4'.repeat(40));

    const indexed = indexGovernanceDecisionReceipts([first, second, revoke]);

    expect(
      resolveGovernanceExceptionDecisions(indexed, {
        exceptionKind: 'repository-structure',
        candidateHead,
      }),
    ).toEqual([
      {
        decisionId: second.decisionId,
        projection: {
          ...structureProjection(),
          target: 'packages/example/other-singleton',
        },
      },
    ]);
  });

  it('expires an approval for a different candidate head and rejects duplicate decision IDs', () => {
    const approval = approvalEvidence('repository-structure', structureProjection());
    const indexed = indexGovernanceDecisionReceipts([
      approval,
      { ...approval, commitOid: '8'.repeat(40) },
    ]);

    expect(
      resolveGovernanceExceptionDecisions(indexed, {
        exceptionKind: 'repository-structure',
        candidateHead: '7'.repeat(40),
      }),
    ).toEqual([]);
    expect(indexed.issues).toContain(`duplicate governance decision ID: ${approval.decisionId}`);
    expect(
      resolveGovernanceExceptionDecisions(indexed, {
        exceptionKind: 'repository-structure',
        candidateHead,
      }),
    ).toEqual([]);
  });

  it.each([
    ['repository-structure', structureProjection()],
    ['production-legacy', productionLegacyProjection()],
    ['repository-code-style', codeStyleProjection()],
    ['test-structure-coupling', testCouplingProjection()],
  ])('returns only the native %s projection', (exceptionKind, projection) => {
    const approval = approvalEvidence(exceptionKind, projection);
    const indexed = indexGovernanceDecisionReceipts([approval]);

    expect(
      resolveGovernanceExceptionDecisions(indexed, {
        exceptionKind,
        candidateHead,
      }),
    ).toEqual([{ decisionId: approval.decisionId, projection }]);
  });

  it('indexes the exact retained failed gate deviation independently of actor permission', () => {
    const evidence = gateEvidence();
    const indexed = indexGovernanceDecisionReceipts([evidence]);

    expect(
      resolveGovernanceGateDeviations(indexed, {
        candidateSha: candidateHead,
        gateName: 'Governance Gate / Governance Gate',
      }),
    ).toEqual([
      {
        decisionId: evidence.decisionId,
        workflowRunId: 81,
        runAttempt: 2,
        gateName: 'Governance Gate / Governance Gate',
        candidateSha: candidateHead,
        status: 'accepted-deviation',
        underlyingStatus: 'failed',
      },
    ]);
  });

  it('reads only an explicitly trusted origin/main revision, never branch-local receipts', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'trusted-governance-receipts-'));
    fixtureRoots.push(root);
    runGit(root, ['init', '--initial-branch=main']);
    runGit(root, ['config', 'user.name', 'Receipt Fixture']);
    runGit(root, ['config', 'user.email', 'receipt@example.invalid']);
    const trusted = approvalEvidence('repository-structure', structureProjection());
    writeEvidence(root, trusted);
    runGit(root, ['add', '.']);
    runGit(root, ['commit', '-m', 'trusted receipt']);
    const trustedRevision = runGit(root, ['rev-parse', 'HEAD']).trim();
    runGit(root, ['update-ref', 'refs/remotes/origin/main', trustedRevision]);
    runGit(root, ['switch', '-c', 'feature']);
    const branchOnly = approvalEvidence('repository-structure', {
      ...structureProjection(),
      target: 'packages/example/branch-only',
    });
    writeEvidence(root, branchOnly);
    runGit(root, ['add', '.']);
    runGit(root, ['commit', '-m', 'branch-only receipt']);

    const indexed = readTrustedGovernanceDecisionIndex({
      root,
      trustedRevision,
      verifyDecisionCommit: ({ commitOid, decisionId }: any) => ({ commitOid, decisionId }),
      verifyDecisionAdmission: ({ commitOid, decisionId }: any) => ({
        commitOid,
        decisionId,
        workflowRunId: 701,
        runAttempt: 1,
      }),
    });

    expect(indexed.issues).toEqual([]);
    expect(indexed.decisions.map((decision: any) => decision.decisionId)).toEqual([
      trusted.decisionId,
    ]);
    expect(indexed.decisions.map((decision: any) => decision.decisionId)).not.toContain(
      branchOnly.decisionId,
    );
  });

  it('rejects a receipt added on merged feature history instead of direct trusted-main lineage', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'trusted-governance-merged-history-'));
    fixtureRoots.push(root);
    runGit(root, ['init', '--initial-branch=main']);
    runGit(root, ['config', 'user.name', 'Receipt Fixture']);
    runGit(root, ['config', 'user.email', 'receipt@example.invalid']);
    writeFileSync(path.join(root, 'README.md'), 'base\n');
    runGit(root, ['add', '.']);
    runGit(root, ['commit', '-m', 'base']);
    runGit(root, ['switch', '-c', 'feature']);
    const featureReceipt = approvalEvidence('repository-structure', structureProjection());
    writeEvidence(root, featureReceipt);
    runGit(root, ['add', '.']);
    runGit(root, ['commit', '-m', 'handcrafted feature receipt']);
    runGit(root, ['switch', 'main']);
    runGit(root, ['commit', '--allow-empty', '-m', 'advance protected main']);
    runGit(root, ['merge', '--no-ff', 'feature', '-m', 'merge feature history']);
    const trustedRevision = runGit(root, ['rev-parse', 'HEAD']).trim();
    runGit(root, ['update-ref', 'refs/remotes/origin/main', trustedRevision]);
    let verified = false;

    const indexed = readTrustedGovernanceDecisionIndex({
      root,
      trustedRevision,
      verifyDecisionCommit: () => {
        verified = true;
        throw new Error('feature-history receipt must not reach provenance verification');
      },
    });

    expect(verified).toBe(false);
    expect(indexed.decisions).toEqual([]);
    expect(indexed.issues.join('\n')).toContain(
      'adding commit is not on the trusted main first-parent lineage',
    );
  });

  it('retains a directly ingested historical receipt after the actor loses admin', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'trusted-governance-role-loss-'));
    fixtureRoots.push(root);
    runGit(root, ['init', '--initial-branch=main']);
    runGit(root, ['config', 'user.name', 'Receipt Fixture']);
    runGit(root, ['config', 'user.email', 'receipt@example.invalid']);
    const historical = approvalEvidence('repository-structure', structureProjection());
    writeEvidence(root, historical);
    runGit(root, ['add', '.']);
    runGit(root, ['commit', '-m', 'direct authenticated decision']);
    const trustedRevision = runGit(root, ['rev-parse', 'HEAD']).trim();
    runGit(root, ['update-ref', 'refs/remotes/origin/main', trustedRevision]);

    const indexed = readTrustedGovernanceDecisionIndex({
      root,
      trustedRevision,
      verifyDecisionCommit: ({ commitOid, decisionId }: any) => ({ commitOid, decisionId }),
      verifyDecisionAdmission: ({ commitOid, decisionId }: any) => ({
        commitOid,
        decisionId,
        workflowRunId: 701,
        runAttempt: 1,
      }),
    });

    expect(indexed.issues).toEqual([]);
    expect(indexed.decisions.map((decision: any) => decision.decisionId)).toEqual([
      historical.decisionId,
    ]);
  });

  it('rejects a one-parent first-parent receipt without durable authenticated admission', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'trusted-governance-no-admission-'));
    fixtureRoots.push(root);
    runGit(root, ['init', '--initial-branch=main']);
    runGit(root, ['config', 'user.name', 'Receipt Fixture']);
    runGit(root, ['config', 'user.email', 'receipt@example.invalid']);
    const handcrafted = writeExactHandcraftedReceipt(root);
    const trustedRevision = handcrafted.commitOid;
    runGit(root, ['update-ref', 'refs/remotes/origin/main', trustedRevision]);

    const indexed = readTrustedGovernanceDecisionIndex({
      root,
      trustedRevision,
      verifyDecisionCommit: ({ commitOid, decisionId }: any) => {
        const structural = verifyGovernanceDecisionCommit({
          commitOid,
          readRepositorySnapshot: (revision: string) =>
            readGitRepositorySnapshot({ repoRoot: root, commitOid: revision }),
        });
        expect(structural.decisionId).toBe(decisionId);
        return { commitOid, decisionId };
      },
      verifyDecisionAdmission: () => {
        throw new Error('decision commit has no authenticated main-push admission');
      },
    });

    expect(indexed.decisions).toEqual([]);
    expect(indexed.issues.join('\n')).toContain('no authenticated main-push admission');
  });

  it('excludes forged and mixed receipt commits from the trusted index', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'trusted-governance-forgery-'));
    fixtureRoots.push(root);
    runGit(root, ['init', '--initial-branch=main']);
    runGit(root, ['config', 'user.name', 'Receipt Fixture']);
    runGit(root, ['config', 'user.email', 'receipt@example.invalid']);
    const forged = approvalEvidence('repository-structure', structureProjection());
    writeEvidence(root, forged);
    writeFileSync(path.join(root, 'mixed.txt'), 'additional change\n');
    runGit(root, ['add', '.']);
    runGit(root, ['commit', '-m', 'forged mixed receipt']);
    const trustedRevision = runGit(root, ['rev-parse', 'HEAD']).trim();
    runGit(root, ['update-ref', 'refs/remotes/origin/main', trustedRevision]);

    const indexed = readTrustedGovernanceDecisionIndex({
      root,
      trustedRevision,
      verifyDecisionCommit: () => {
        throw new Error('commit contains an additional undeclared change');
      },
    });

    expect(indexed.decisions).toEqual([]);
    expect(indexed.issues[0]).toContain('commit contains an additional undeclared change');
  });

  it('reports every noncanonical entry under the immutable receipt directory', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'trusted-governance-paths-'));
    fixtureRoots.push(root);
    runGit(root, ['init', '--initial-branch=main']);
    runGit(root, ['config', 'user.name', 'Receipt Fixture']);
    runGit(root, ['config', 'user.email', 'receipt@example.invalid']);
    const nested = path.join(root, 'governance/decisions/nested');
    mkdirSync(nested, { recursive: true });
    writeFileSync(path.join(nested, 'unexpected.json'), '{}\n');
    writeFileSync(path.join(root, 'governance/decisions/README.md'), 'not a receipt\n');
    runGit(root, ['add', '.']);
    runGit(root, ['commit', '-m', 'malformed receipt paths']);
    const trustedRevision = runGit(root, ['rev-parse', 'HEAD']).trim();
    runGit(root, ['update-ref', 'refs/remotes/origin/main', trustedRevision]);

    const indexed = readTrustedGovernanceDecisionIndex({
      root,
      trustedRevision,
      verifyDecisionCommit: ({ commitOid, decisionId }: any) => ({ commitOid, decisionId }),
    });

    expect(indexed.decisions).toEqual([]);
    expect(indexed.issues).toEqual([
      'governance/decisions/README.md is not a canonical immutable receipt path',
      'governance/decisions/nested/unexpected.json is not a canonical immutable receipt path',
    ]);
  });

  it.each(['modified', 'deleted'])('excludes a receipt later %s on trusted main', (mutation) => {
    const root = mkdtempSync(path.join(tmpdir(), 'trusted-governance-immutability-'));
    fixtureRoots.push(root);
    runGit(root, ['init', '--initial-branch=main']);
    runGit(root, ['config', 'user.name', 'Receipt Fixture']);
    runGit(root, ['config', 'user.email', 'receipt@example.invalid']);
    const approval = approvalEvidence('repository-structure', structureProjection());
    writeEvidence(root, approval);
    runGit(root, ['add', '.']);
    runGit(root, ['commit', '-m', 'add receipt']);
    const addingCommit = runGit(root, ['rev-parse', 'HEAD']).trim();
    if (mutation === 'modified') {
      writeFileSync(path.join(root, approval.path), `${approval.content} `);
      runGit(root, ['add', approval.path]);
    } else {
      runGit(root, ['rm', approval.path]);
    }
    runGit(root, ['commit', '-m', `${mutation} receipt`]);
    const trustedRevision = runGit(root, ['rev-parse', 'HEAD']).trim();
    runGit(root, ['update-ref', 'refs/remotes/origin/main', trustedRevision]);

    const indexed = readTrustedGovernanceDecisionIndex({
      root,
      trustedRevision,
      verifyDecisionCommit: ({ commitOid, decisionId }: any) => {
        expect(commitOid).toBe(addingCommit);
        return { commitOid, decisionId };
      },
    });

    expect(indexed.decisions).toEqual([]);
    expect(indexed.issues.join('\n')).toContain('immutable receipt path changed after creation');
  });
});

function approvalEvidence(exceptionKind: string, projection: object) {
  const request = decodeGovernanceDecisionRequest({
    ...commonRequest('exception.decide'),
    target: {
      action: 'approve',
      exceptionKind,
      candidateHead,
      projectionSha256: computeSha256(toCanonicalJson(projection)),
    },
    payload: { projection },
  });
  return receiptEvidence(request, {
    status: 'approved',
    decisionId: computeGovernanceDecisionId(request),
  });
}

function revocationEvidence(priorDecisionId: string, expectedHeadOid: string) {
  const request = decodeGovernanceDecisionRequest({
    ...commonRequest('exception.decide', expectedHeadOid),
    target: { action: 'revoke', priorDecisionId },
    payload: {},
  });
  return receiptEvidence(request, {
    status: 'revoked',
    decisionId: computeGovernanceDecisionId(request),
  });
}

function gateEvidence() {
  const request = decodeGovernanceDecisionRequest({
    ...commonRequest('gate.accept-deviation'),
    target: {
      workflowRunId: 81,
      runAttempt: 2,
      gateName: 'Governance Gate / Governance Gate',
      candidateSha: candidateHead,
    },
    payload: {},
  });
  const decisionId = computeGovernanceDecisionId(request);
  return receiptEvidence(request, {
    status: 'accepted-deviation',
    underlyingStatus: 'failed',
    decisionId,
  });
}

function receiptEvidence(request: any, result: object) {
  const receipt = createGovernanceDecisionReceipt({
    request,
    actor: { login: 'historical-admin', permission: 'admin' },
    transport: { kind: 'local-gh' },
    result,
    bypassedInvariants: [],
    stateChanges: [],
  });
  return {
    decisionId: receipt.decisionId,
    path: `governance/decisions/${receipt.decisionId}.json`,
    commitOid: request.expectedHeadOid,
    content: serializeGovernanceDecisionReceipt(receipt),
  };
}

function writeExactHandcraftedReceipt(root: string) {
  writeFileSync(path.join(root, 'README.md'), 'fixture\n');
  runGit(root, ['add', '.']);
  runGit(root, ['commit', '-m', 'base']);
  const expectedHeadOid = runGit(root, ['rev-parse', 'HEAD']).trim();
  const projection = structureProjection();
  const request = decodeGovernanceDecisionRequest({
    ...commonRequest('exception.decide', expectedHeadOid),
    target: {
      action: 'approve',
      exceptionKind: 'repository-structure',
      candidateHead,
      projectionSha256: computeSha256(toCanonicalJson(projection)),
    },
    payload: { projection },
  });
  const transition = computeGovernanceDecisionTransition({
    request,
    snapshot: readGitRepositorySnapshot({ repoRoot: root, commitOid: expectedHeadOid }),
  });
  const receipt = createGovernanceDecisionReceipt({
    request,
    actor: { login: 'fabricated-non-admin', permission: 'admin' },
    transport: { kind: 'local-gh' },
    result: transition.result,
    bypassedInvariants: transition.bypassedInvariants,
    stateChanges: transition.stateChanges,
  });
  const receiptPath = path.join(root, transition.receiptPath);
  mkdirSync(path.dirname(receiptPath), { recursive: true });
  writeFileSync(receiptPath, serializeGovernanceDecisionReceipt(receipt));
  runGit(root, ['add', '.']);
  runGit(root, ['commit', '-m', 'squash-style handcrafted receipt']);
  return {
    decisionId: transition.decisionId,
    commitOid: runGit(root, ['rev-parse', 'HEAD']).trim(),
  };
}

function commonRequest(operation: string, expectedHeadOid = '1'.repeat(40)) {
  return {
    schemaVersion: 'governance-decision-request-v1',
    operation,
    repository: 'intact-software-systems/ar-eye-hunter',
    defaultBranch: 'main',
    expectedHeadOid,
    force: true,
    reason: 'Administrator accepts this exact governance state.',
  };
}

function structureProjection() {
  return {
    ruleId: 'topology.singleton-subtree',
    target: 'packages/example/singleton',
    owner: 'Example maintainers',
    reviewOrRemovalCondition: 'Remove when another module joins the subtree.',
  };
}

function productionLegacyProjection() {
  const retainedLedgerProjection = [
    {
      id: 'production-legacy-example',
      path: 'packages/example/legacy.ts',
      symbol: 'legacyExample',
      classification: 'legacy',
      disposition: 'retained-pending-human-approval',
      purpose: 'Preserve compatibility.',
      consumerDependency: 'External consumer.',
      unsafeRemovalReason: 'Migration is incomplete.',
      minimization: 'Direct alias only.',
      canonicalOwner: 'packages/example/canonical.ts#example',
      compatibilityTests: 'packages/tests/example/legacy.test.ts',
      owner: 'Example maintainers',
      removalCondition: 'Remove after migration.',
      approvedProductionSha: candidateHead,
    },
  ];
  return {
    retainedLedgerProjection,
    ledgerSha256: computeSha256(JSON.stringify(retainedLedgerProjection)),
    approvedProductionSha: candidateHead,
    candidateHead,
  };
}

function codeStyleProjection() {
  return {
    rule: 'file.cognitive-load',
    path: 'packages/example/large-owner.ts',
    symbol: null,
    magnitude: 112,
    candidateHead,
  };
}

function testCouplingProjection() {
  const semanticCoverage =
    'packages/tests/example/public.test.ts#keeps the public contract callable';
  return {
    candidate: {
      id: 'test-structure-coupling-example',
      path: 'packages/tests/example/structure.test.ts',
      line: 12,
      column: 7,
      kind: 'production-source-read',
    },
    semanticContract: {
      id: 'example-public-contract',
      domain: 'Example public API',
      owner: 'Example maintainers',
      summary: 'The public contract remains directly callable.',
      semanticCoverage,
      coverageRelation: 'The semantic test exercises the protected public contract.',
    },
    disposition: {
      kind: 'durable-boundary',
      boundary: 'public',
      owner: 'Example maintainers',
      rationale: 'The source read protects a public boundary.',
      semanticCoverage,
    },
    candidateHead,
  };
}

function writeEvidence(root: string, evidence: any) {
  const file = path.join(root, evidence.path);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, evidence.content);
}

function runGit(root: string, arguments_: string[]) {
  return execFileSync('git', arguments_, { cwd: root, encoding: 'utf8' });
}
