import { afterEach, describe, expect, it, vi } from 'vitest';
import {
    waitForRtcHealth,
    waitForRtcMessageAbsence,
    waitForRtcMessages,
    type RtcWaitInput
} from '../../../shared-test/black-box-runner/rtc/rtc-wait-expectations.ts';

function createWaitInput(response: Record<string, unknown>): RtcWaitInput {
    const interaction = { request: { connection: 'peer', scenarioExecutionNumber: 1, interactionExecutionNumber: 1 }, response };
    return {
        interaction,
        config: { interaction, interactionName: 'observe' },
        context: { rtcMessages: { peer: [] }, rtcConnections: {}, rtcCloseEvents: {} }
    };
}

afterEach(() => vi.useRealTimers());

describe('RTC observation waits', () => {
    it('does not reuse a message for duplicate expectations or consume a partial ordered match', async () => {
        vi.useFakeTimers();
        const input = createWaitInput({ messages: [{ value: 1 }, { value: 1 }], ordered: true, consume: true, withinMs: 50 });
        input.context.rtcMessages.peer.push({ data: { value: 1 } });
        const waiting = waitForRtcMessages(input);
        await vi.advanceTimersByTimeAsync(50);
        expect((await waiting).status).toBe('FAILURE');
        expect(input.context.rtcMessages.peer).toHaveLength(1);
        input.context.rtcMessages.peer.push({ data: { value: 1 } });
        const complete = waitForRtcMessages(input);
        await vi.advanceTimersByTimeAsync(50);
        expect((await complete).actual.matchedMessages).toHaveLength(2);
        expect(input.context.rtcMessages.peer).toEqual([]);
    });

    it('rejects a provider failure instead of leaving the wait unresolved', async () => {
        vi.useFakeTimers();
        const input = createWaitInput({ health: { connected: true }, withinMs: 100 });
        input.context.rtcConnections.peer = {
            client: {
                diagnostics() {
                    throw new Error('provider closed');
                }
            }
        };
        const outcome = waitForRtcHealth(input).catch((error: Error) => error.message);
        await vi.advanceTimersByTimeAsync(100);
        expect(await outcome).toBe('provider closed');
    });

    it('keeps an absence observation open for the entire requested window', async () => {
        vi.useFakeTimers();
        const input = createWaitInput({ absent: { value: 1 }, withinMs: 100 });
        let result: string | undefined;
        const waiting = waitForRtcMessageAbsence(input).then((value) => {
            result = value.status;
        });
        await vi.advanceTimersByTimeAsync(99);
        expect(result).toBeUndefined();
        input.context.rtcMessages.peer.push({ data: { value: 1 } });
        await vi.advanceTimersByTimeAsync(1);
        await waiting;
        expect(result).toBe('FAILURE');
    });
});
