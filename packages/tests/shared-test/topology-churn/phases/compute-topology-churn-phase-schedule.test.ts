import { computeTopologyChurnPhaseSchedule } from '@shared-test/black-box-runner/topology-churn/phases/compute-topology-churn-phase-schedule.ts';
import { describe, expect, it } from 'vitest';

describe('computeTopologyChurnPhaseSchedule', () => {
    it('alternates join and leave every interval from the phase\'s start, starting with a join', () => {
        const schedule = computeTopologyChurnPhaseSchedule({ name: 'churn', shape: 'alternate', durationMs: 90_000 });

        // 90 s at one step every 3 s: 30 steps, at 0, 3 000, …, 87 000.
        expect(schedule.name).toBe('churn');
        expect(schedule.durationMs).toBe(90_000);
        expect(schedule.steps).toHaveLength(30);
        expect(schedule.steps.slice(0, 4)).toEqual([
            { offsetMs: 0, action: { kind: 'join' } },
            { offsetMs: 3_000, action: { kind: 'leave' } },
            { offsetMs: 6_000, action: { kind: 'join' } },
            { offsetMs: 9_000, action: { kind: 'leave' } }
        ]);
        expect(schedule.steps.at(-1)).toEqual({ offsetMs: 87_000, action: { kind: 'leave' } });
        expect(schedule.steps.map((step) => step.action.kind)).toEqual(
            Array.from({ length: 15 }, () => ['join', 'leave']).flat()
        );
    });

    it('places no step at the phase\'s end', () => {
        const schedule = computeTopologyChurnPhaseSchedule({ name: 'churn', shape: 'alternate', durationMs: 9_000 });

        // 9 000 itself is the phase's end, so the last step is at 6 000.
        expect(schedule).toEqual({
            name: 'churn',
            durationMs: 9_000,
            steps: [
                { offsetMs: 0, action: { kind: 'join' } },
                { offsetMs: 3_000, action: { kind: 'leave' } },
                { offsetMs: 6_000, action: { kind: 'join' } }
            ]
        });
    });
});
