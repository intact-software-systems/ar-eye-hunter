import { describe, expect, it } from 'vitest';

import {
    verifyHistoricalGovernanceDecisionCommit,
    verifyPublishedGovernanceDecisionCommit
} from '../../../../scripts/governance-decisions/governance-decision-remote-verification.mjs';

describe('published governance decision verification', () => {
    it('consumes historical verified identity without rechecking current actor permission', () => {
        const result = verifyHistoricalGovernanceDecisionCommit({
            commitOid: '9'.repeat(40),
            structuralVerification: localVerification(),
            readCommit: () => verifiedCommit({ login: 'repository-admin', type: 'User' }),
            readPermission: () => {
                throw new Error('historical verification must not query current permission');
            }
        });

        expect(result).toMatchObject({ decisionOnly: true, authenticatedActor: 'repository-admin' });
    });
    it('accepts a verified local commit linked to the recorded administrator', () => {
        const result = verifyPublishedGovernanceDecisionCommit({
            commitOid: '9'.repeat(40),
            structuralVerification: localVerification(),
            readCommit: () => verifiedCommit({ login: 'repository-admin', type: 'User' }),
            readPermission: () => ({ permission: 'admin', user: { login: 'repository-admin' } })
        });

        expect(result).toMatchObject({ decisionOnly: true, authenticatedActor: 'repository-admin' });
    });

    it('rejects unverified, missing, mismatched, and no-longer-admin local evidence', () => {
        expect(() =>
            verifyPublishedGovernanceDecisionCommit({
                commitOid: '9'.repeat(40),
                structuralVerification: localVerification(),
                readCommit: () => ({
                    ...verifiedCommit({ login: 'repository-admin', type: 'User' }),
                    commit: { verification: { verified: false } }
                }),
                readPermission: adminPermission
            })
        ).toThrow('governance decision commit must have GitHub verified identity');
        expect(() =>
            verifyPublishedGovernanceDecisionCommit({
                commitOid: '9'.repeat(40),
                structuralVerification: localVerification(),
                readCommit: () => verifiedCommit({ login: 'different-user', type: 'User' }),
                readPermission: adminPermission
            })
        ).toThrow('local governance commit author must equal the recorded administrator');
        expect(() =>
            verifyPublishedGovernanceDecisionCommit({
                commitOid: '9'.repeat(40),
                structuralVerification: localVerification(),
                readCommit: () => verifiedCommit({ login: 'repository-admin', type: 'User' }),
                readPermission: () => ({ permission: 'maintain' })
            })
        ).toThrow('recorded governance actor must currently have admin permission');
        expect(() =>
            verifyPublishedGovernanceDecisionCommit({
                commitOid: '9'.repeat(40),
                structuralVerification: localVerification(),
                readCommit: () => verifiedCommit({ login: 'repository-admin', type: 'User' }),
                readPermission: () => ({ permission: 'admin' })
            })
        ).toThrow('recorded governance actor must currently have admin permission');
    });

    it('accepts the exact originating workflow run while it is in progress', () => {
        const result = verifyPublishedGovernanceDecisionCommit({
            commitOid: '9'.repeat(40),
            structuralVerification: workflowVerification(),
            appSlug: 'governance-decisions',
            readCommit: () => verifiedCommit({ login: 'governance-decisions[bot]', type: 'Bot' }),
            readWorkflowRun: () => trustedWorkflowRun(),
            readPermission: adminPermission
        });

        expect(result).toMatchObject({ decisionOnly: true, authenticatedActor: 'repository-admin' });
    });

    it('rejects a validly verified commit from an App other than the trusted repository App', () => {
        expect(() =>
            verifyPublishedGovernanceDecisionCommit({
                commitOid: '9'.repeat(40),
                structuralVerification: workflowVerification(),
                appSlug: 'different-governance-app',
                readCommit: () =>
                    verifiedCommit({
                        login: 'different-governance-app[bot]',
                        type: 'Bot'
                    }),
                readWorkflowRun: () => trustedWorkflowRun(),
                readPermission: adminPermission
            })
        ).toThrow('configured governance App slug does not match trusted repository policy');
    });

    it.each([
        ['event', { event: 'push' }],
        ['attempt', { run_attempt: 3 }],
        ['actor', { actor: { login: 'different-admin' } }],
        ['head', { head_sha: '8'.repeat(40) }],
        ['path', { path: '.github/workflows/different.yml' }],
        ['branch', { head_branch: 'feature' }],
        ['status', { status: 'queued' }]
    ])('rejects altered workflow %s evidence', (_name, alteration) => {
        expect(() =>
            verifyPublishedGovernanceDecisionCommit({
                commitOid: '9'.repeat(40),
                structuralVerification: workflowVerification(),
                appSlug: 'governance-decisions',
                readCommit: () => verifiedCommit({ login: 'governance-decisions[bot]', type: 'Bot' }),
                readWorkflowRun: () => ({ ...trustedWorkflowRun(), ...alteration }),
                readPermission: adminPermission
            })
        ).toThrow('workflow governance commit must match its exact trusted dispatch run');
    });
});

function localVerification() {
    return {
        decisionOnly: true,
        decisionId: '1'.repeat(64),
        operation: 'plan.cancel',
        receiptPath: `governance/decisions/${'1'.repeat(64)}.json`,
        receipt: {
            actor: { login: 'repository-admin', permission: 'admin' },
            transport: { kind: 'local-gh' },
            request: { expectedHeadOid: '7'.repeat(40) }
        }
    };
}

function workflowVerification() {
    return {
        ...localVerification(),
        receipt: {
            actor: { login: 'repository-admin', permission: 'admin' },
            request: { expectedHeadOid: '7'.repeat(40) },
            transport: {
                kind: 'workflow-dispatch',
                runId: 123,
                runAttempt: 2,
                workflowRef: 'intact-software-systems/ar-eye-hunter/.github/workflows/governance-decision.yml@refs/heads/main',
                workflowSha: '7'.repeat(40)
            }
        }
    };
}

function verifiedCommit(author: { login: string; type: string; }) {
    return {
        sha: '9'.repeat(40),
        author,
        commit: { verification: { verified: true } }
    };
}

function trustedWorkflowRun() {
    return {
        id: 123,
        event: 'workflow_dispatch',
        run_attempt: 2,
        actor: { login: 'repository-admin' },
        head_sha: '7'.repeat(40),
        head_branch: 'main',
        path: '.github/workflows/governance-decision.yml',
        status: 'in_progress'
    };
}

function adminPermission() {
    return { permission: 'admin', user: { login: 'repository-admin' } };
}
