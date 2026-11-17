import { computeTopologyChurnPhaseWindows } from '@shared-test/black-box-runner/topology-churn/compute-topology-churn-phase-windows.ts';
import { describe, expect, it } from 'vitest';

describe('computeTopologyChurnPhaseWindows', () => {
    it('ends formation one settle after the last presence answer and starts churn at that same instant', () => {
        const windows = computeTopologyChurnPhaseWindows({
            formationStartedAtEpochMs: 10_000,
            lastPresenceAnsweredAtEpochMs: 14_500,
            memberCount: 8,
            settleMs: 6_000,
            churnEndedAtEpochMs: 110_700,
            churnEvents: [
                { kind: 'join' },
                { kind: 'leave', memberId: 'a' },
                { kind: 'join' },
                { kind: 'skip' },
                { kind: 'join' }
            ]
        });

        // Every one of the room's members joins during formation, the creator included; nobody leaves.
        expect(windows).toEqual([
            { name: 'formation', startedAtEpochMs: 10_000, endedAtEpochMs: 20_500, joinCount: 8, leaveCount: 0 },
            { name: 'churn', startedAtEpochMs: 20_500, endedAtEpochMs: 110_700, joinCount: 3, leaveCount: 1 }
        ]);
    });

    it('counts no churn joins or leaves when the loop ran no event', () => {
        const [formation, churn] = computeTopologyChurnPhaseWindows({
            formationStartedAtEpochMs: 0,
            lastPresenceAnsweredAtEpochMs: 1_000,
            memberCount: 3,
            settleMs: 6_000,
            churnEndedAtEpochMs: 97_000,
            churnEvents: []
        });

        expect(formation.joinCount).toBe(3);
        expect(churn).toMatchObject({ startedAtEpochMs: 7_000, joinCount: 0, leaveCount: 0 });
    });
});
