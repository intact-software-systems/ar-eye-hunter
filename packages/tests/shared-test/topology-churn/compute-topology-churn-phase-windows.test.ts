import { computeTopologyChurnPhaseWindows } from '@shared-test/black-box-runner/topology-churn/compute-topology-churn-phase-windows.ts';
import { describe, expect, it } from 'vitest';

describe('computeTopologyChurnPhaseWindows', () => {
    it('ends formation one settle after the last presence answer and spans churn over its loop', () => {
        const windows = computeTopologyChurnPhaseWindows({
            formationStartedAtEpochMs: 10_000,
            lastPresenceAnsweredAtEpochMs: 14_500,
            formationJoinCount: 8,
            settleMs: 6_000,
            churnStartedAtEpochMs: 20_600,
            churnEndedAtEpochMs: 110_700,
            churnEvents: [
                { kind: 'join' },
                { kind: 'leave', memberId: 'a' },
                { kind: 'join' },
                { kind: 'skip' },
                { kind: 'join' }
            ]
        });

        expect(windows).toEqual([
            { name: 'formation', startedAtEpochMs: 10_000, endedAtEpochMs: 20_500, joinCount: 8, leaveCount: 0 },
            { name: 'churn', startedAtEpochMs: 20_600, endedAtEpochMs: 110_700, joinCount: 3, leaveCount: 1 }
        ]);
    });

    it('counts no churn joins or leaves when the loop ran no event', () => {
        const [, churn] = computeTopologyChurnPhaseWindows({
            formationStartedAtEpochMs: 0,
            lastPresenceAnsweredAtEpochMs: 1_000,
            formationJoinCount: 3,
            settleMs: 6_000,
            churnStartedAtEpochMs: 7_000,
            churnEndedAtEpochMs: 97_000,
            churnEvents: []
        });

        expect(churn).toMatchObject({ joinCount: 0, leaveCount: 0 });
    });
});
