import { createDefaultGroupLifecyclePolicy } from '@shared/api/group-lifecycle/group-lifecycle-policy-presets.ts';
import { describe, expect, it } from 'vitest';

import {
    evaluateGroupStageTrigger,
    resolveGroupStageTrigger,
    toStageTriggerTimerDelayMs
} from '@shared/api/group-lifecycle/evaluate-group-stage-trigger.ts';

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

describe('stage trigger timer delay', () => {
    it.each([
        ['immediate', { kind: 'immediate' } as const, 0],
        ['after', { kind: 'after', settleMs: 700 } as const, 700],
        ['presence', { kind: 'presence', memberCount: 2, fallbackMs: 5_000 } as const, 5_000],
        ['manual', { kind: 'manual' } as const, null]
    ])('gives the %s trigger its durable leg', (_kind, trigger, expected) => {
        expect(toStageTriggerTimerDelayMs(trigger)).toBe(expected);
    });
});

describe('stage trigger selection', () => {
    const policy = createDefaultGroupLifecyclePolicy();

    it('gives forming the plan trigger and planned the connect trigger', () => {
        expect(resolveGroupStageTrigger(policy, 'forming')).toBe(policy.establishment.planTrigger);
        expect(resolveGroupStageTrigger(policy, 'planned')).toBe(policy.establishment.connectTrigger);
    });

    it.each(['dormant', 'connecting', 'active', 'reconfiguring', 'reconnecting'] as const)(
        'governs no boundary from %s',
        (lifecycleState) => {
            expect(resolveGroupStageTrigger(policy, lifecycleState)).toBe(null);
        }
    );
});

describe('a trigger evaluated without its stage entry', () => {
    const nowEpochMs = 10_000;

    it.each([
        ['manual', { kind: 'manual' } as const, 'wait'],
        ['after', { kind: 'after', settleMs: 0 } as const, 'wait'],
        ['presence below its threshold', { kind: 'presence', memberCount: 3, fallbackMs: 0 } as const, 'wait']
    ])('waits for %s, whose elapsed half belongs to the timer leg', (_name, trigger, expected) => {
        expect(evaluateGroupStageTrigger({
            trigger,
            stageEnteredAtEpochMs: null,
            nowEpochMs,
            livePresenceMemberCount: 2
        })).toBe(expected);
    });

    it('fires a presence trigger whose threshold is met', () => {
        expect(evaluateGroupStageTrigger({
            trigger: { kind: 'presence', memberCount: 2, fallbackMs: 600_000 },
            stageEnteredAtEpochMs: null,
            nowEpochMs,
            livePresenceMemberCount: 2
        })).toBe('fire');
    });
});
