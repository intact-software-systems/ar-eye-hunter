import { describe, expect, it } from 'vitest';

import type { AlmConformanceStepInput } from '@shared-test/rallar-bb-test/conformance/alm/alm-conformance-scenario-definition.ts';
import { toPollCommand } from '@shared-test/rallar-bb-test/conformance/alm/poll/alm-conformance-poll-commands.ts';
import {
    RALLAR_BLACK_BOX_LOOP_UNTIL_EXHAUSTED,
    runLoopUntilFirstSuccess
} from '@shared-test/rallar-bb-test/loop/loop-until.ts';
import type {
    RallarBlackBoxTestCommand,
    RallarBlackBoxTestLoopCommand
} from '@shared-test/rallar-bb-test/rallar-black-box-test-contracts.ts';

import { toConformanceInput } from './alm-conformance-test-input.ts';

const step: AlmConformanceStepInput = {
    input: toConformanceInput('ws'),
    scenarioId: 'delivery-baseline',
    scenarioKey: 'delivery-baseline',
    role: 'receiver',
    roles: ['sender', 'receiver'],
    messages: {},
    connect: undefined
};

/** An attempt as a publish loop's: a send, an observe that waits, and asserts that read cached results. */
const ATTEMPT: readonly RallarBlackBoxTestCommand[] = [
    { kind: 'stats', commandId: 'send', timeoutMs: 5_000 },
    { kind: 'stats', commandId: 'observe', timeoutMs: 15_000 },
    { kind: 'assert', commandId: 'fact', source: 'resultCache.observe.value', operator: 'exists', timeoutMs: 5_000 }
];

interface AttemptRun {
    readonly starts: readonly number[];
    readonly ends: readonly number[];
    readonly code: string | undefined;
}

/** Runs the poll's loop under the runtime's first-success executor on a clock that each failed attempt moves. */
async function runFailingAttempts(poll: RallarBlackBoxTestLoopCommand, attemptMs: number): Promise<AttemptRun> {
    let nowMs = 0;
    const starts: number[] = [];
    const ends: number[] = [];
    const outcome = await runLoopUntilFirstSuccess({
        command: poll,
        count: poll.count!,
        durationMs: poll.durationMs,
        intervalMs: poll.intervalMs!,
        deadlineEpochMs: poll.timeoutMs,
        loopStartedAtEpochMs: 0,
        now: () => nowMs,
        sleep: async (ms) => {
            nowMs += ms;
            return 'slept';
        },
        cancelRequested: () => false,
        runIteration: async () => {
            starts.push(nowMs);
            nowMs += attemptMs;
            ends.push(nowMs);
            return { kind: 'completed', failedChildResult: { commandId: 'fact' } as never };
        },
        toLoopValue: () => ({}) as never,
        toTimedOutOutcome: () => ({ status: 'failed', error: { code: 'timed-out', message: 'timed out' } }),
        toSuccessOutcome: () => ({ status: 'ok' })
    });
    return { starts, ends, code: outcome.error?.code };
}

function toPoll(phaseMs: number): RallarBlackBoxTestLoopCommand {
    const poll = toPollCommand({ step, name: 'poll', phaseMs, commands: ATTEMPT });
    if (poll.kind !== 'loop') {
        throw new Error('A poll is a loop.');
    }
    return poll;
}

describe('toPollCommand', () => {
    it('starts attempts for one phase and sets the deadline one attempt\'s budget after it, asserts reading cached results', () => {
        expect(toPoll(90_000)).toMatchObject({
            kind: 'loop',
            until: 'first-success',
            durationMs: 90_000,
            intervalMs: 250,
            timeoutMs: 90_000 + 5_000 + 15_000
        });
    });

    it('starts no attempt after the phase, and the last one started runs its whole budget before the deadline', async () => {
        const poll = toPoll(90_000);
        const run = await runFailingAttempts(poll, 20_000);

        expect(run.code).toBe(RALLAR_BLACK_BOX_LOOP_UNTIL_EXHAUSTED);
        expect(run.starts.every((startMs) => startMs < 90_000)).toBe(true);
        expect(run.ends.at(-1)!).toBeLessThanOrEqual(poll.timeoutMs!);
    });

    it('caps attempts that each fail at once at the count the phase allows, which the phase reaches first', async () => {
        const poll = toPoll(90_000);
        const run = await runFailingAttempts(poll, 0);

        expect(run.code).toBe(RALLAR_BLACK_BOX_LOOP_UNTIL_EXHAUSTED);
        expect(run.starts).toHaveLength(poll.count!);
        expect(run.starts.at(-1)).toBe(90_000 - 250);
    });
});
