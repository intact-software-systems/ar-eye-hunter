import { describe, expect, it } from 'vitest';

import { evaluateGroupStageTrigger } from '@shared/api/group-lifecycle/evaluate-group-stage-trigger.ts';

const ENTERED = 1_700_000_000_000;

describe('evaluateGroupStageTrigger', () => {
    it('never fires a manual trigger', () => {
        expect(evaluateGroupStageTrigger({
            trigger: { kind: 'manual' },
            stageEnteredAtEpochMs: ENTERED,
            nowEpochMs: ENTERED + 600_000,
            livePresenceMemberCount: 1_000
        })).toBe('wait');
    });

    it('fires an immediate trigger on entry', () => {
        expect(evaluateGroupStageTrigger({
            trigger: { kind: 'immediate' },
            stageEnteredAtEpochMs: ENTERED,
            nowEpochMs: ENTERED,
            livePresenceMemberCount: 0
        })).toBe('fire');
    });

    it.each([
        { elapsed: 999, decision: 'wait' },
        { elapsed: 1_000, decision: 'fire' }
    ])('an after trigger with elapsed $elapsed reads $decision', (row) => {
        expect(evaluateGroupStageTrigger({
            trigger: { kind: 'after', settleMs: 1_000 },
            stageEnteredAtEpochMs: ENTERED,
            nowEpochMs: ENTERED + row.elapsed,
            livePresenceMemberCount: 0
        })).toBe(row.decision);
    });

    // Whichever comes first: the member threshold or the timer fallback.
    it.each([
        { members: 3, elapsed: 0, decision: 'fire' },
        { members: 2, elapsed: 0, decision: 'wait' },
        { members: 0, elapsed: 5_000, decision: 'fire' }
    ])('a presence trigger with $members members after $elapsed reads $decision', (row) => {
        expect(evaluateGroupStageTrigger({
            trigger: { kind: 'presence', memberCount: 3, fallbackMs: 5_000 },
            stageEnteredAtEpochMs: ENTERED,
            nowEpochMs: ENTERED + row.elapsed,
            livePresenceMemberCount: row.members
        })).toBe(row.decision);
    });
});
