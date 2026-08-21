import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { readGitRepositorySnapshot } from '../../../../scripts/governance-decisions/git-repository-snapshot.mjs';
import { verifyGovernanceDecisionCommit } from '../../../../scripts/governance-decisions/governance-decision-commit-verification.mjs';
import { createGovernanceDecisionReceipt, serializeGovernanceDecisionReceipt } from '../../../../scripts/governance-decisions/governance-decision-receipt.mjs';
import { decodeGovernanceDecisionRequest } from '../../../../scripts/governance-decisions/governance-decision-request.mjs';
import { computeGovernanceDecisionTransition } from '../../../../scripts/governance-decisions/governance-decision-transition.mjs';

const fixtureRoots: string[] = [];

afterEach(() => {
    for (const fixtureRoot of fixtureRoots.splice(0)) {
        rmSync(fixtureRoot, { recursive: true, force: true });
    }
});

describe('governance exception commit verification', () => {
    it('replays exact failed gate evidence for a receipt-only decision commit', () => {
        const fixture = createGateDecisionFixture();

        const verification = verifyGovernanceDecisionCommit({
            commitOid: fixture.commitOid,
            readRepositorySnapshot: (commitOid: string) => readGitRepositorySnapshot({ repoRoot: fixture.root, commitOid }),
            readGateEvidence: () => failedGateEvidence(fixture.candidateSha)
        });

        expect(verification).toMatchObject({
            decisionOnly: true,
            operation: 'gate.accept-deviation',
            decisionId: fixture.transition.decisionId
        });
        expect(() =>
            verifyGovernanceDecisionCommit({
                commitOid: fixture.commitOid,
                readRepositorySnapshot: (commitOid: string) => readGitRepositorySnapshot({ repoRoot: fixture.root, commitOid })
            })
        ).toThrow('gate.accept-deviation requires the exact failed gate evidence reader');
    });
});

function createGateDecisionFixture() {
    const root = mkdtempSync(path.join(tmpdir(), 'governance-gate-decision-'));
    fixtureRoots.push(root);
    runGit(root, ['init', '--initial-branch=main']);
    runGit(root, ['config', 'user.name', 'Governance Fixture']);
    runGit(root, ['config', 'user.email', 'governance@example.invalid']);
    writeFileSync(path.join(root, 'README.md'), 'fixture\n');
    runGit(root, ['add', '.']);
    runGit(root, ['commit', '-m', 'base']);
    const parentOid = runGit(root, ['rev-parse', 'HEAD']).trim();
    const candidateSha = '2'.repeat(40);
    const request = decodeGovernanceDecisionRequest({
        schemaVersion: 'governance-decision-request-v1',
        operation: 'gate.accept-deviation',
        repository: 'intact-software-systems/ar-eye-hunter',
        defaultBranch: 'main',
        expectedHeadOid: parentOid,
        force: true,
        reason: 'Accept the exact failed governance gate.',
        target: {
            workflowRunId: 81,
            runAttempt: 2,
            gateName: 'Governance Gate / Governance Gate',
            candidateSha
        },
        payload: {}
    });
    const snapshot = readGitRepositorySnapshot({ repoRoot: root, commitOid: parentOid });
    const transition = computeGovernanceDecisionTransition({
        request,
        snapshot,
        readGateEvidence: () => failedGateEvidence(candidateSha)
    });
    const receipt = createGovernanceDecisionReceipt({
        request,
        actor: { login: 'repository-admin', permission: 'admin' },
        transport: { kind: 'local-gh' },
        result: transition.result,
        bypassedInvariants: transition.bypassedInvariants,
        stateChanges: transition.stateChanges
    });
    const receiptPath = path.join(root, transition.receiptPath);
    mkdirSync(path.dirname(receiptPath), { recursive: true });
    writeFileSync(receiptPath, serializeGovernanceDecisionReceipt(receipt));
    runGit(root, ['add', '.']);
    runGit(root, ['commit', '-m', 'governance gate decision']);
    return {
        root,
        candidateSha,
        transition,
        commitOid: runGit(root, ['rev-parse', 'HEAD']).trim()
    };
}

function failedGateEvidence(candidateSha: string) {
    return {
        run: {
            id: 81,
            run_attempt: 2,
            head_sha: candidateSha,
            status: 'completed',
            conclusion: 'failure'
        },
        jobs: [
            {
                id: 91,
                run_id: 81,
                run_attempt: 2,
                head_sha: candidateSha,
                name: 'Governance Gate / Governance Gate',
                status: 'completed',
                conclusion: 'failure'
            }
        ]
    };
}

function runGit(root: string, arguments_: string[]) {
    return execFileSync('git', arguments_, { cwd: root, encoding: 'utf8' });
}
