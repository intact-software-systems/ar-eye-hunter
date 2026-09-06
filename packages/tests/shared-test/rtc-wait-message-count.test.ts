import { describe, expect, it } from 'vitest';

import type { ApiJsonObject, ApiJsonValue } from '@shared/api/api-json-value.ts';

import { waitForRtcMessageCount } from '../../shared-test/black-box-runner/rtc/rtc-wait-expectations.ts';

const connection = 'aliceRtc';

async function runCount(input: {
    expectFields: ApiJsonObject;
    payloads: readonly ApiJsonValue[];
}): Promise<{ status: string; result: string; matchedCount?: number; }> {
    const interaction = {
        request: {
            action: 'wait',
            connection,
            scenarioExecutionNumber: 1,
            interactionExecutionNumber: 1
        },
        response: { connection, withinMs: 30, ...input.expectFields }
    };
    const status = await waitForRtcMessageCount({
        interaction,
        config: { interactionName: 'countRtcFrames', interaction },
        context: { rtcMessages: { [connection]: input.payloads.map((data) => ({ data })) } }
    });

    return {
        status: status.status,
        result: status.result,
        matchedCount: status.actual?.matchedCount
    };
}

const motion = { payload: { typeId: 'motion.tick' } };
const chat = { payload: { typeId: 'chat.message' } };

describe('waitForRtcMessageCount', () => {
    it('accepts an exact count of matching frames', async () => {
        const result = await runCount({
            expectFields: { message: { payload: { typeId: 'motion.tick' } }, count: 2 },
            payloads: [motion, chat, motion]
        });

        expect(result.status).toBe('SUCCESS');
        expect(result.matchedCount).toBe(2);
    });

    it('rejects a count outside the expectation', async () => {
        const result = await runCount({
            expectFields: { message: { payload: { typeId: 'motion.tick' } }, count: 1 },
            payloads: [motion, motion]
        });

        expect(result.status).toBe('FAILURE');
        expect(result.result).toBe('RTC message count did not match the expectation');
        expect(result.matchedCount).toBe(2);
    });

    it('accepts a bounded range', async () => {
        const result = await runCount({
            expectFields: { message: { payload: { typeId: 'motion.tick' } }, count: { min: 1 } },
            payloads: [motion, motion, motion]
        });

        expect(result.status).toBe('SUCCESS');
    });

    // The two guards and a genuine count mismatch all report FAILURE, so each
    // case names its own message; otherwise a broken guard passes as the other.
    it('requires a message matcher to count against', async () => {
        const result = await runCount({ expectFields: { count: 1 }, payloads: [motion] });

        expect(result.status).toBe('FAILURE');
        expect(result.result).toBe('RTC count wait expects expect.message to match frames against.');
    });

    it('rejects a count object that names no bound', async () => {
        const result = await runCount({
            expectFields: { message: { payload: { typeId: 'motion.tick' } }, count: {} },
            payloads: [motion, motion]
        });

        expect(result.status).toBe('FAILURE');
        expect(result.result).toBe('RTC count wait expects expect.count to be a non-negative integer or {min,max}.');
    });
});
