import { describe, expect, it } from 'vitest';
import { createRtcBaselineArtifactProjector } from '../../../baseline/evidence/rtc-baseline-artifact-projection.ts';

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
        const projector = createRtcBaselineArtifactProjector({
            environmentId: 'E3-memory',
            environmentObservation: null,
            conflictingSampleCode: 'conflicting-sample',
            conflictingSampleMessage: () => 'conflicting sample',
            sha256: async () => 'a'.repeat(64)
        });

        await expect(
            projector.appendFailureOutcome({ identity, outcome: 'failed', issues })
        ).resolves.toEqual({ ok: true, value: undefined });
        expect(projector.getProjection()).toMatchObject({
            cohortOutcomes: [{ identity, outcome: 'failed', issues }],
            failures: [{ identity, outcome: 'failed', issues }]
        });
    });
});
