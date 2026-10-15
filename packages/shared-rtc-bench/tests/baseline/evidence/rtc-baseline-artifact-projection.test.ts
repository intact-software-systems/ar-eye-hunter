import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type { RtcBaselineSampleDto } from '../../../baseline/contracts/rtc-baseline-contracts.ts';
import { createRtcBaselineArtifactProjector } from '../../../baseline/evidence/rtc-baseline-artifact-projection.ts';

function projector() {
    return createRtcBaselineArtifactProjector({
        environmentId: 'E3-memory',
        environmentObservation: null,
        conflictingSampleCode: 'conflicting-sample',
        conflictingSampleMessage: () => 'conflicting sample',
        sha256: async (bytes) => createHash('sha256').update(bytes).digest('hex')
    });
}

function failedSample(): RtcBaselineSampleDto {
    return {
        schema: 'rallar.rtc-baseline.sample.v1',
        identity: {
            sampleId: 'rtc-b06-retention-100-e3-memory-retention-100-retained-001-001',
            workloadId: 'RTC-B06',
            caseId: 'retention-100',
            inputKey: 'e3-memory-retention-100',
            intendedPhase: 'retained',
            outerOrdinal: 1,
            innerOrdinal: 1
        },
        outcome: 'failed',
        evidenceClass: 'local-full-stack',
        metrics: [{ metric: 'durationMs', unit: 'ms', value: 42 }],
        rawEvidence: { journal: { status: 'failed', reason: 'missing terminal' } },
        rawReferences: [{ relativePath: 'artifacts/journals/failed.jsonl', bytes: 42, sha256: 'a'.repeat(64) }],
        issues: [{ path: '$.journal', code: 'journal-unverified', message: 'missing terminal' }],
        runtimeObservation: null
    };
}

describe('RTC baseline artifact projection', () => {
    it('projects a cohort failure into both direct and derived accounting', async () => {
        const identity = {
            cohortId: 'rtc-b06-e3-memory-retention',
            workloadId: 'RTC-B06' as const,
            memberSampleIds: ['rtc-b06-retention-member']
        };
        const issues = [
            {
                path: '$.identity.memberSampleIds',
                code: 'cohort-members-unavailable',
                message: 'Cohort assertion cannot run after a member sample failed or was causally not run.'
            }
        ];
        const projection = projector();

        await expect(
            projection.appendFailureOutcome({ identity, outcome: 'failed', issues })
        ).resolves.toEqual({ ok: true, value: undefined });
        expect(projection.getProjection()).toMatchObject({
            cohortOutcomes: [{ identity, outcome: 'failed', issues }],
            failures: [{ identity, outcome: 'failed', issues }]
        });
    });

    it.each(['sample-first', 'receipt-first'] as const)('reconciles the same failed sample and receipt %s while retaining only raw evidence', async (order) => {
        const projection = projector();
        const sample = failedSample();
        const receipt = { identity: sample.identity, outcome: 'failed' as const, issues: sample.issues };
        const first = order === 'sample-first'
            ? await projection.appendStoredArtifact(sample)
            : await projection.appendFailureOutcome(receipt);
        const second = order === 'sample-first'
            ? await projection.appendFailureOutcome(receipt)
            : await projection.appendStoredArtifact(sample);
        expect([first, second]).toEqual([{ ok: true, value: undefined }, { ok: true, value: undefined }]);
        expect(projection.getProjection()).toMatchObject({
            sampleOutcomes: [receipt],
            failures: [receipt],
            rawReferences: sample.rawReferences,
            metricObservations: []
        });
        expect(await projection.appendFailureOutcome(receipt)).toMatchObject({
            ok: false,
            issues: [{ code: 'duplicate-failure-outcome' }]
        });
    });

    it.each(['sample-first', 'receipt-first'] as const)('rejects contradictory status, identity, or issues %s', async (order) => {
        for (const contradiction of ['status', 'identity', 'issues'] as const) {
            const projection = projector();
            const sample = failedSample();
            const receipt = {
                identity: contradiction === 'identity' ? { ...sample.identity, innerOrdinal: 2 } : sample.identity,
                outcome: contradiction === 'status' ? 'not-run' as const : 'failed' as const,
                issues: contradiction === 'issues' ? [] : sample.issues
            };
            const first = order === 'sample-first'
                ? await projection.appendStoredArtifact(sample)
                : await projection.appendFailureOutcome(receipt);
            expect(first.ok).toBe(true);
            const second = order === 'sample-first'
                ? await projection.appendFailureOutcome(receipt)
                : await projection.appendStoredArtifact(sample);
            expect(second).toMatchObject({ ok: false, issues: [{ code: 'conflicting-failure-sample' }] });
        }
    });
});
