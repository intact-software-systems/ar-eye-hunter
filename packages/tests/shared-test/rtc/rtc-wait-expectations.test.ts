import { afterEach, describe, expect, it, vi } from 'vitest';
import {
    waitForRtcHealth,
    waitForRtcMessage,
    waitForRtcMessageAbsence,
    waitForRtcMessageCount,
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
    it('decodes nested JSON consistently for single, ordered, count and absence waits while retaining wire evidence', async () => {
        vi.useFakeTimers();
        const expected = { payload: { resource: { event: 'selected' } } };
        const input = createWaitInput({
            message: expected,
            messages: [expected],
            absent: expected,
            count: 1,
            ordered: true,
            decodeJsonPaths: ['payload.resource'],
            withinMs: 50
        });
        const wire = { data: { payload: { resource: '{"event":"selected"}' } } };
        input.context.rtcMessages.peer.push({ data: { payload: { resource: '{"event":"other"}' } } }, wire);
        const waits = Promise.all([
            waitForRtcMessage(input),
            waitForRtcMessages(input),
            waitForRtcMessageCount(input),
            waitForRtcMessageAbsence(input)
        ]);
        await vi.advanceTimersByTimeAsync(50);
        const [single, ordered, count, absence] = await waits;
        expect(single).toMatchObject({ status: 'SUCCESS', actual: { matchedMessage: wire } });
        expect(ordered).toMatchObject({ status: 'SUCCESS', actual: { matchedMessages: [{ matchedMessage: wire }] } });
        expect(count).toMatchObject({ status: 'SUCCESS', actual: { matchedCount: 1 } });
        expect(absence).toMatchObject({ status: 'FAILURE', actual: { matchedMessage: wire } });
        expect(input.context.rtcMessages.peer[1]).toEqual(wire);
    });

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

    it('cannot certify absence after another wait consumes the matching frame', async () => {
        vi.useFakeTimers();
        const input = createWaitInput({ absent: { value: 1 }, withinMs: 100 });
        const absence = waitForRtcMessageAbsence(input);
        input.context.rtcMessages.peer.push({ data: { value: 1 } });
        const consumer = createWaitInput({ message: { value: 1 }, consume: true, withinMs: 100 });
        const consumed = waitForRtcMessage({ ...consumer, context: input.context });
        await vi.advanceTimersByTimeAsync(100);
        expect((await consumed).status).toBe('SUCCESS');
        expect(await absence).toMatchObject({
            status: 'FAILURE',
            result: 'RTC absence cannot be established because observations were discarded'
        });
    });
});
