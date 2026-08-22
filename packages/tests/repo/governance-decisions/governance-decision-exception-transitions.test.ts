import { describe, expect, it } from 'vitest';

import { computeSha256, toCanonicalJson } from '../../../../scripts/governance-decisions/canonical-json.mjs';
import { computeGovernanceDecisionId, decodeGovernanceDecisionRequest } from '../../../../scripts/governance-decisions/governance-decision-request.mjs';
import { computeGovernanceDecisionTransition } from '../../../../scripts/governance-decisions/governance-decision-transition.mjs';

const headOid = '1'.repeat(40);
const candidateSha = '2'.repeat(40);

describe('governance decision exception transitions', () => {
    it('accepts only the exact completed failed gate evidence and retains failure in the result', () => {
        const request = gateRequest();
        const decisionId = computeGovernanceDecisionId(request);
        const transition = computeGovernanceDecisionTransition({
            request,
            snapshot: emptySnapshot(),
            readGateEvidence: () => failedGateEvidence()
        });

        expect(transition).toMatchObject({
            decisionId,
            result: { status: 'accepted-deviation', underlyingStatus: 'failed', decisionId },
            additions: [],
            deletions: [],
            stateChanges: [],
            bypassedInvariants: [
                `governance gate must pass: run 81 attempt 2 ` +
                `gate Governance Gate / Governance Gate candidate ${candidateSha}`
            ]
        });
    });

    it.each([
        ['missing job', { jobs: [] }],
        ['successful job', { jobs: [{ ...failedGateEvidence().jobs[0], conclusion: 'success' }] }],
        ['cancelled job', { jobs: [{ ...failedGateEvidence().jobs[0], conclusion: 'cancelled' }] }],
        ['different attempt', { run: { ...failedGateEvidence().run, run_attempt: 3 } }],
        ['different gate', { jobs: [{ ...failedGateEvidence().jobs[0], name: 'Release Gate' }] }],
        ['different SHA', { run: { ...failedGateEvidence().run, head_sha: '3'.repeat(40) } }],
        ['ambiguous job', { jobs: [failedGateEvidence().jobs[0], failedGateEvidence().jobs[0]] }]
    ])('fails closed for %s evidence', (_label, patch) => {
        const evidence = { ...failedGateEvidence(), ...patch };
        expect(() =>
            computeGovernanceDecisionTransition({
                request: gateRequest(),
                snapshot: emptySnapshot(),
                readGateEvidence: () => evidence
            })
        ).toThrow('gate.accept-deviation requires one exact completed failed gate');
    });

    it('approves a fingerprint-bound native exception through a receipt-only transition', () => {
        const request = structureApprovalRequest();
        const decisionId = computeGovernanceDecisionId(request);

        const transition = computeGovernanceDecisionTransition({
            request,
            snapshot: emptySnapshot()
        });

        expect(transition).toMatchObject({
            decisionId,
            result: { status: 'approved', decisionId },
            additions: [],
            deletions: [],
            stateChanges: [],
            bypassedInvariants: [
                `repository-structure exception requires PR-backed authentication: ${candidateSha}`
            ]
        });
    });

    it('revokes only an existing applicable approval decision ID', () => {
        const prior = structureApprovalRequest();
        const priorDecisionId = computeGovernanceDecisionId(prior);
        const request = decodeGovernanceDecisionRequest({
            ...commonRequest('exception.decide'),
            target: { action: 'revoke', priorDecisionId },
            payload: {}
        });

        const transition = computeGovernanceDecisionTransition({
            request,
            snapshot: emptySnapshot(),
            readGovernanceDecision: () => ({ request: prior })
        });

        expect(transition.result).toEqual({
            status: 'revoked',
            decisionId: computeGovernanceDecisionId(request)
        });
        expect(transition.bypassedInvariants).toEqual([
            `exception revocation requires PR-backed registry mutation: ${priorDecisionId}`
        ]);
        expect(() =>
            computeGovernanceDecisionTransition({
                request,
                snapshot: emptySnapshot(),
                readGovernanceDecision: () => undefined
            })
        ).toThrow('exception.decide revoke target must identify an existing approval');
        expect(() =>
            computeGovernanceDecisionTransition({
                request,
                snapshot: emptySnapshot(),
                readGovernanceDecision: () => ({ request: prior }),
                readGovernanceDecisionRevocations: () => [priorDecisionId]
            })
        ).toThrow('exception.decide revoke target must identify an active approval');
    });
});

function commonRequest(operation: string) {
    return {
        schemaVersion: 'governance-decision-request-v1',
        operation,
        repository: 'intact-software-systems/ar-eye-hunter',
        defaultBranch: 'main',
        expectedHeadOid: headOid,
        force: true,
        reason: 'Administrator accepts this exact governance state.'
    };
}

function gateRequest() {
    return decodeGovernanceDecisionRequest({
        ...commonRequest('gate.accept-deviation'),
        target: {
            workflowRunId: 81,
            runAttempt: 2,
            gateName: 'Governance Gate / Governance Gate',
            candidateSha
        },
        payload: {}
    });
}

function structureApprovalRequest() {
    const projection = {
        ruleId: 'topology.singleton-subtree',
        target: 'packages/example/singleton',
        owner: 'Example maintainers',
        reviewOrRemovalCondition: 'Remove when a second owned module joins the subtree.'
    };
    return decodeGovernanceDecisionRequest({
        ...commonRequest('exception.decide'),
        target: {
            action: 'approve',
            exceptionKind: 'repository-structure',
            candidateHead: candidateSha,
            projectionSha256: computeSha256(toCanonicalJson(projection))
        },
        payload: { projection }
    });
}

function emptySnapshot() {
    return { headOid, commitDate: '2026-08-13', entries: [] };
}

function failedGateEvidence() {
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
