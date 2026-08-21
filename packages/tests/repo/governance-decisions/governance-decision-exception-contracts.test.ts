import { describe, expect, it } from 'vitest';

import { computeSha256, toCanonicalJson } from '../../../../scripts/governance-decisions/canonical-json.mjs';
import { createGovernanceDecisionReceipt } from '../../../../scripts/governance-decisions/governance-decision-receipt.mjs';
import { computeGovernanceDecisionId, decodeGovernanceDecisionRequest } from '../../../../scripts/governance-decisions/governance-decision-request.mjs';

const expectedHeadOid = '1'.repeat(40);
const candidateHead = '2'.repeat(40);

describe('governance decision exception contracts', () => {
    it('accepts one exact failed gate identity and records its retained failure', () => {
        const request = decodeGovernanceDecisionRequest(gateDeviationRequest());
        const decisionId = computeGovernanceDecisionId(request);
        const receipt = createGovernanceDecisionReceipt({
            request,
            actor: { login: 'repository-admin', permission: 'admin' },
            transport: { kind: 'local-gh' },
            result: { status: 'accepted-deviation', underlyingStatus: 'failed', decisionId },
            bypassedInvariants: [],
            stateChanges: []
        });

        expect(request.target).toEqual({
            workflowRunId: 81,
            runAttempt: 2,
            gateName: 'Governance Gate / Governance Gate',
            candidateSha: candidateHead
        });
        expect(receipt.result).toEqual({
            status: 'accepted-deviation',
            underlyingStatus: 'failed',
            decisionId
        });
        expect(() =>
            decodeGovernanceDecisionRequest({
                ...gateDeviationRequest(),
                target: { ...gateDeviationRequest().target, actor: 'claimed' }
            })
        ).toThrow(
            'gate.accept-deviation target must contain exactly: workflowRunId, runAttempt, gateName, candidateSha'
        );
    });

    it.each([
        ['repository-structure', structureProjection()],
        ['production-legacy', productionLegacyProjection()],
        ['repository-code-style', codeStyleProjection()],
        ['test-structure-coupling', testCouplingProjection()]
    ])('accepts an exact fingerprint-bound %s approval', (exceptionKind, projection) => {
        const request = decodeGovernanceDecisionRequest(
            exceptionApprovalRequest(exceptionKind, projection)
        );

        expect(request.target).toEqual({
            action: 'approve',
            exceptionKind,
            candidateHead,
            projectionSha256: computeSha256(toCanonicalJson(projection))
        });
        expect(request.payload).toEqual({ projection });
    });

    it('rejects projection key, fingerprint, and candidate-head ambiguity', () => {
        const projection = structureProjection();
        expect(() =>
            decodeGovernanceDecisionRequest(
                exceptionApprovalRequest('repository-structure', { ...projection, extra: true })
            )
        ).toThrow(
            'repository-structure projection must contain exactly: ruleId, target, owner, reviewOrRemovalCondition'
        );
        expect(() =>
            decodeGovernanceDecisionRequest({
                ...exceptionApprovalRequest('repository-structure', projection),
                target: {
                    ...exceptionApprovalRequest('repository-structure', projection).target,
                    projectionSha256: 'f'.repeat(64)
                }
            })
        ).toThrow('projectionSha256 must match the canonical projection');

        const codeStyle = codeStyleProjection();
        expect(() =>
            decodeGovernanceDecisionRequest({
                ...exceptionApprovalRequest('repository-code-style', codeStyle),
                target: {
                    ...exceptionApprovalRequest('repository-code-style', codeStyle).target,
                    candidateHead: '3'.repeat(40)
                }
            })
        ).toThrow('repository-code-style projection candidateHead must equal target candidateHead');

        const productionLegacy = productionLegacyProjection();
        expect(() =>
            decodeGovernanceDecisionRequest(
                exceptionApprovalRequest('production-legacy', {
                    ...productionLegacy,
                    ledgerSha256: 'f'.repeat(64)
                })
            )
        ).toThrow('production-legacy projection ledgerSha256 must match retainedLedgerProjection');
        for (
            const retainedLedgerProjection of [
                [
                    {
                        ...productionLegacy.retainedLedgerProjection[0],
                        classification: 'compatibility-alias'
                    }
                ],
                [
                    {
                        ...productionLegacy.retainedLedgerProjection[0],
                        disposition: 'resolved'
                    }
                ],
                [productionLegacy.retainedLedgerProjection[0], productionLegacy.retainedLedgerProjection[0]]
            ]
        ) {
            expect(() =>
                decodeGovernanceDecisionRequest(
                    exceptionApprovalRequest('production-legacy', {
                        ...productionLegacy,
                        retainedLedgerProjection,
                        ledgerSha256: computeSha256(JSON.stringify(retainedLedgerProjection))
                    })
                )
            ).toThrow();
        }
    });

    it('revokes exactly one prior approval decision without accepting a projection', () => {
        const priorDecisionId = 'a'.repeat(64);
        const request = decodeGovernanceDecisionRequest({
            ...commonRequest('exception.decide'),
            target: { action: 'revoke', priorDecisionId },
            payload: {}
        });

        expect(request.target).toEqual({ action: 'revoke', priorDecisionId });
        expect(() =>
            decodeGovernanceDecisionRequest({
                ...request,
                payload: { projection: structureProjection() }
            })
        ).toThrow('exception.decide revoke payload must be empty');
    });
});

function commonRequest(operation: string) {
    return {
        schemaVersion: 'governance-decision-request-v1',
        operation,
        repository: 'intact-software-systems/ar-eye-hunter',
        defaultBranch: 'main',
        expectedHeadOid,
        force: true,
        reason: 'Administrator accepts this exact governance state.'
    };
}

function gateDeviationRequest() {
    return {
        ...commonRequest('gate.accept-deviation'),
        target: {
            workflowRunId: 81,
            runAttempt: 2,
            gateName: 'Governance Gate / Governance Gate',
            candidateSha: candidateHead
        },
        payload: {}
    };
}

function exceptionApprovalRequest(exceptionKind: string, projection: object) {
    return {
        ...commonRequest('exception.decide'),
        target: {
            action: 'approve',
            exceptionKind,
            candidateHead,
            projectionSha256: computeSha256(toCanonicalJson(projection))
        },
        payload: { projection }
    };
}

function structureProjection() {
    return {
        ruleId: 'topology.singleton-subtree',
        target: 'packages/example/singleton',
        owner: 'Example package maintainers',
        reviewOrRemovalCondition: 'Remove when another sibling joins the subtree.'
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
            purpose: 'Preserve the downstream public import.',
            consumerDependency: 'External example consumer.',
            unsafeRemovalReason: 'The consumer has not migrated.',
            minimization: 'The alias delegates directly to the canonical owner.',
            canonicalOwner: 'packages/example/canonical.ts#canonicalExample',
            compatibilityTests: 'packages/tests/example/legacy-compat.test.ts',
            owner: 'Example package maintainers',
            removalCondition: 'Remove after the external consumer migrates.',
            approvedProductionSha: candidateHead
        }
    ];
    return {
        retainedLedgerProjection,
        ledgerSha256: computeSha256(JSON.stringify(retainedLedgerProjection)),
        approvedProductionSha: candidateHead,
        candidateHead
    };
}

function codeStyleProjection() {
    return {
        rule: 'file.cognitive-load',
        path: 'packages/example/large-owner.ts',
        symbol: null,
        magnitude: 112,
        candidateHead
    };
}

function testCouplingProjection() {
    return {
        candidate: {
            id: 'test-structure-coupling-example',
            path: 'packages/tests/example/structure.test.ts',
            line: 12,
            column: 7,
            kind: 'production-source-read'
        },
        semanticContract: {
            id: 'example-public-contract',
            domain: 'Example public API',
            owner: 'Example maintainers',
            summary: 'The example public contract remains directly callable.',
            semanticCoverage: 'packages/tests/example/public.test.ts#keeps the public contract callable',
            coverageRelation: 'The semantic test executes the exact public contract protected here.'
        },
        disposition: {
            kind: 'durable-boundary',
            boundary: 'public',
            owner: 'Example maintainers',
            rationale: 'The source read protects a published ownership boundary.',
            semanticCoverage: 'packages/tests/example/public.test.ts#keeps the public contract callable'
        },
        candidateHead
    };
}
