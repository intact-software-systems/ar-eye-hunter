import { afterEach, describe, expect, it, vi } from 'vitest';

import type { ApiJsonValue } from '@shared/api/api-json-value.ts';

import {
    waitForWsMessage,
    waitForWsMessageCount,
    type WsInteraction,
    type WsInteractionResponse,
    type WsWaitContext
} from '../../shared-test/black-box-runner/ws/ws-wait-expectations.ts';

const connection = 'wsAlice';

function toInteraction(expectFields: WsInteractionResponse): WsInteraction {
    return {
        request: {
            action: 'wait',
            connection
        },
        response: { connection, withinMs: 30, ...expectFields }
    };
}

function toContext(payloads: readonly ApiJsonValue[]): WsWaitContext {
    return { wsMessages: { [connection]: payloads.map((data) => ({ data })) } };
}

async function runCount(input: {
    expectFields: WsInteractionResponse;
    payloads: readonly ApiJsonValue[];
}): Promise<{ status: string; result: string; matchedCount?: number; }> {
    const interaction = toInteraction(input.expectFields);
    const status = await waitForWsMessageCount({
        interaction,
        config: { interactionName: 'countFrames', interaction },
        context: toContext(input.payloads)
    });

    return {
        status: status.status,
        result: String(status.result ?? ''),
        matchedCount: Number(status.actual.matchedCount)
    };
}

const decided = { payload: { typeId: 'admission.decided' } };
const other = { payload: { typeId: 'group.updated' } };

describe('waitForWsMessageCount', () => {
    it('accepts an exact count of matching frames', async () => {
        const result = await runCount({
            expectFields: { message: { payload: { typeId: 'admission.decided' } }, count: 1 },
            payloads: [other, decided, other]
        });

        expect(result.status).toBe('SUCCESS');
        expect(result.matchedCount).toBe(1);
    });

    it('rejects a second matching frame under an exact count', async () => {
        const result = await runCount({
            expectFields: { message: { payload: { typeId: 'admission.decided' } }, count: 1 },
            payloads: [decided, decided]
        });

        expect(result.status).toBe('FAILURE');
        expect(result.result).toBe('WebSocket message count did not match the expectation');
        expect(result.matchedCount).toBe(2);
    });

    it('rejects an absent frame under an exact count', async () => {
        const result = await runCount({
            expectFields: { message: { payload: { typeId: 'admission.decided' } }, count: 1 },
            payloads: [other]
        });

        expect(result.status).toBe('FAILURE');
        expect(result.matchedCount).toBe(0);
    });

    it('accepts a bounded range', async () => {
        const result = await runCount({
            expectFields: { message: { payload: { typeId: 'admission.decided' } }, count: { min: 1, max: 3 } },
            payloads: [decided, decided]
        });

        expect(result.status).toBe('SUCCESS');
        expect(result.matchedCount).toBe(2);
    });

    it('rejects a count above the range maximum', async () => {
        const result = await runCount({
            expectFields: { message: { payload: { typeId: 'admission.decided' } }, count: { min: 0, max: 1 } },
            payloads: [decided, decided]
        });

        expect(result.status).toBe('FAILURE');
    });

    // count: 0 is a stricter absence claim than expect.absent, because it also
    // reports how many frames were seen while it waited.
    it('accepts zero as an absence claim', async () => {
        const result = await runCount({
            expectFields: { message: { payload: { typeId: 'admission.decided' } }, count: 0 },
            payloads: [other, other]
        });

        expect(result.status).toBe('SUCCESS');
        expect(result.matchedCount).toBe(0);
    });

    // The two guards and a genuine count mismatch all report FAILURE, so each
    // case names its own message; otherwise a broken guard passes as the other.
    it('requires a message matcher to count against', async () => {
        const result = await runCount({ expectFields: { count: 1 }, payloads: [decided] });

        expect(result.status).toBe('FAILURE');
        expect(result.result).toBe('WebSocket count wait expects expect.message to match frames against.');
    });

    it('rejects a range whose minimum exceeds its maximum', async () => {
        const result = await runCount({
            expectFields: { message: { payload: { typeId: 'admission.decided' } }, count: { min: 3, max: 1 } },
            payloads: [decided]
        });

        expect(result.status).toBe('FAILURE');
        expect(result.result).toBe('WebSocket count wait expects expect.count to be a non-negative integer or {min,max}.');
    });

    it('rejects a count object that names no bound', async () => {
        const result = await runCount({
            expectFields: { message: { payload: { typeId: 'admission.decided' } }, count: {} },
            payloads: [decided, decided]
        });

        expect(result.status).toBe('FAILURE');
        expect(result.result).toBe('WebSocket count wait expects expect.count to be a non-negative integer or {min,max}.');
    });
});

afterEach(() => vi.useRealTimers());

describe('WebSocket count observation window', () => {
    it('waits for a late duplicate before deciding an exact count', async () => {
        vi.useFakeTimers();
        const interaction = toInteraction({ message: decided, count: 1, withinMs: 100 });
        const context = toContext([decided]);
        const pending = waitForWsMessageCount({ interaction, context, config: { interaction } });
        await vi.advanceTimersByTimeAsync(50);
        context.wsMessages[connection]!.push({ data: decided });
        await vi.advanceTimersByTimeAsync(50);
        expect(await pending).toMatchObject({ status: 'FAILURE', actual: { matchedCount: 2, waitedMs: 100 } });
    });

    it('cannot certify a count after another wait consumes an observation', async () => {
        vi.useFakeTimers();
        const interaction = toInteraction({ message: decided, count: 1, withinMs: 100 });
        const context = toContext([decided]);
        const pending = waitForWsMessageCount({ interaction, context, config: { interaction } });
        const consuming = toInteraction({ message: decided, consume: true });
        const consumed = waitForWsMessage({ interaction: consuming, context, config: { interaction: consuming } });
        await vi.advanceTimersByTimeAsync(25);
        expect((await consumed).status).toBe('SUCCESS');
        context.wsMessages[connection]!.push({ data: decided });
        await vi.advanceTimersByTimeAsync(75);
        expect(await pending).toMatchObject({ status: 'FAILURE', result: 'WebSocket count cannot be established because observations were discarded' });
    });

    it('cannot certify a count across a close event', async () => {
        vi.useFakeTimers();
        const interaction = toInteraction({ message: decided, count: 1, withinMs: 100 });
        const context: WsWaitContext = { ...toContext([decided]), wsCloseEvents: { [connection]: [] } };
        const pending = waitForWsMessageCount({ interaction, context, config: { interaction }, observeCloseEvents: true });
        context.wsCloseEvents![connection]!.push({ code: 1000 });
        await vi.advanceTimersByTimeAsync(100);
        expect(await pending).toMatchObject({ status: 'FAILURE', result: 'WebSocket count cannot be established because observations were discarded' });
    });
});
