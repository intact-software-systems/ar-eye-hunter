import { describe, expect, it } from 'vitest';

import type { ApiJsonObject, ApiJsonValue } from '@shared/api/api-json-value.ts';

import { waitForWsMessageCount } from '../../shared-test/black-box-runner/ws/ws-wait-expectations.ts';

const connection = 'wsAlice';

function toInteraction(expectFields: ApiJsonObject): ApiJsonObject {
    return {
        request: {
            action: 'wait',
            connection,
            scenarioExecutionNumber: 1,
            interactionExecutionNumber: 1
        },
        response: { connection, withinMs: 30, ...expectFields }
    };
}

function toContext(payloads: readonly ApiJsonValue[]): ApiJsonObject {
    return { wsMessages: { [connection]: payloads.map((data) => ({ data })) } };
}

function toConfig(interaction: ApiJsonObject): ApiJsonObject {
    return { interactionName: 'countFrames', interaction };
}

async function runCount(input: {
    expectFields: ApiJsonObject;
    payloads: readonly ApiJsonValue[];
}): Promise<{ status: string; matchedCount?: number; }> {
    const interaction = toInteraction(input.expectFields);
    const status = await waitForWsMessageCount({
        interaction,
        config: toConfig(interaction),
        context: toContext(input.payloads)
    });

    return { status: status.status, matchedCount: status.actual?.matchedCount };
}

const decided = { payload: { typeId: 'admission.decided' } };
const other = { payload: { typeId: 'group.updated' } };

describe('waitForWsMessageCount', () => {
    // The assertion slice 4 needs: an admission race must emit exactly one
    // decision, and "at least one" cannot distinguish that from two.
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

    it('requires a message matcher to count against', async () => {
        const result = await runCount({ expectFields: { count: 1 }, payloads: [decided] });

        expect(result.status).toBe('FAILURE');
    });

    it('rejects a range whose minimum exceeds its maximum', async () => {
        const result = await runCount({
            expectFields: { message: { payload: { typeId: 'admission.decided' } }, count: { min: 3, max: 1 } },
            payloads: [decided]
        });

        expect(result.status).toBe('FAILURE');
    });
});
