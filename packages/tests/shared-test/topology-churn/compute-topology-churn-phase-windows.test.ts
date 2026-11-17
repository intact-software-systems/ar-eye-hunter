import { computeTopologyChurnPhaseWindows } from '@shared-test/black-box-runner/topology-churn/compute-topology-churn-phase-windows.ts';
import { describe, expect, it } from 'vitest';

describe('computeTopologyChurnPhaseWindows', () => {
    it('ends formation one settle after the last presence answer and starts churn at that same instant', () => {
        const windows = computeTopologyChurnPhaseWindows({
            formationStartedAtEpochMs: 10_000,
            lastPresenceAnsweredAtEpochMs: 14_500,
            memberCount: 8,
            settleMs: 6_000,
            runs: [{
                name: 'churn',
                endedAtEpochMs: 110_700,
                events: [
                    { kind: 'join' },
                    { kind: 'leave', memberId: 'a' },
                    { kind: 'join' },
                    { kind: 'skip' },
                    { kind: 'join' }
                ]
            }]
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
            runs: [{ name: 'churn', endedAtEpochMs: 97_000, events: [] }]
        });

        expect(formation.joinCount).toBe(3);
        expect(churn).toMatchObject({ startedAtEpochMs: 7_000, joinCount: 0, leaveCount: 0 });
    });

    it('chains each run from the end of the one before, the first from the end of formation', () => {
        const windows = computeTopologyChurnPhaseWindows({
            formationStartedAtEpochMs: 10_000,
            lastPresenceAnsweredAtEpochMs: 14_500,
            memberCount: 4,
            settleMs: 6_000,
            runs: [
                { name: 'churn', endedAtEpochMs: 50_000, events: [] },
                { name: 'churn', endedAtEpochMs: 80_000, events: [] },
                { name: 'churn', endedAtEpochMs: 95_000, events: [] }
            ]
        });

        // Formation ends at 14 500 + 6 000 = 20 500; each later window starts where the one before it ended.
        expect(windows.map((window) => [window.name, window.startedAtEpochMs, window.endedAtEpochMs])).toEqual([
            ['formation', 10_000, 20_500],
            ['churn', 20_500, 50_000],
            ['churn', 50_000, 80_000],
            ['churn', 80_000, 95_000]
        ]);
    });

    it('counts each run\'s own joins and leaves, never a skip', () => {
        const [, first, second] = computeTopologyChurnPhaseWindows({
            formationStartedAtEpochMs: 0,
            lastPresenceAnsweredAtEpochMs: 1_000,
            memberCount: 3,
            settleMs: 6_000,
            runs: [
                { name: 'churn', endedAtEpochMs: 40_000, events: [{ kind: 'join' }, { kind: 'skip' }, { kind: 'join' }] },
                {
                    name: 'churn',
                    endedAtEpochMs: 70_000,
                    events: [
                        { kind: 'leave', memberId: 'a' },
                        { kind: 'skip' },
                        { kind: 'leave', memberId: 'b' },
                        { kind: 'join' }
                    ]
                }
            ]
        });

        // The first run joined two and left none; the second left two and joined one. A skip is neither.
        expect(first).toMatchObject({ joinCount: 2, leaveCount: 0 });
        expect(second).toMatchObject({ joinCount: 1, leaveCount: 2 });
    });
});
