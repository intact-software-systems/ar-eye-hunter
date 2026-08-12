import { describe, expect, it } from 'vitest';
import { createRallarBlackBoxTestRuntime } from '../../shared-test/rallar-bb-test/runtime.ts';
import { validateRallarBlackBoxTestCommand } from '../../shared-test/rallar-bb-test/control-protocol.ts';
import {
    RALLAR_BLACK_BOX_TEST_COMMAND_SCHEMA,
    validateJsonSchema,
} from '../../shared-test/rallar-bb-test/schema.ts';
import type {
    RallarBlackBoxTestAssertCommand,
    RallarBlackBoxTestAssertResultValue,
    RallarBlackBoxTestRuntime,
} from '../../shared-test/rallar-bb-test/types.ts';

function createDeterministicRuntime(): RallarBlackBoxTestRuntime {
    let now = 1_000;
    let sequence = 1;
    return createRallarBlackBoxTestRuntime({
        now: () => now++,
        idFactory: (prefix) => `${prefix}-${sequence++}`,
    });
}

async function evaluateAssert(
    runtime: RallarBlackBoxTestRuntime,
    assert: Omit<RallarBlackBoxTestAssertCommand, 'kind'>,
): Promise<RallarBlackBoxTestAssertResultValue & Readonly<{ ok: boolean }>> {
    const result = await runtime.execute({
        kind: 'assert',
        ...assert,
    });
    return {
        ...(result.value as RallarBlackBoxTestAssertResultValue),
        ok: result.ok,
    };
}

describe('rallar-bb-test extended assert operators', () => {
    it('evaluates numeric bounds, length, and regex operators on recorded evidence', async () => {
        const runtime = createDeterministicRuntime();
        runtime.recordEvent({
            kind: 'message',
            topic: 'room.assert.evidence',
            payload: {
                data: {
                    topic: 'room.assert.evidence',
                    marker: 'assert-operators',
                    score: '17',
                    items: ['alpha', 'beta', 'gamma'],
                },
            },
        });

        expect((await evaluateAssert(runtime, {
            source: 'messages.0.payload.data.items.length',
            operator: 'gt',
            expected: 2,
        })).ok).toBe(true);
        expect((await evaluateAssert(runtime, {
            source: 'messages.0.payload.data.items.length',
            operator: 'lt',
            expected: 4,
        })).ok).toBe(true);
        expect((await evaluateAssert(runtime, {
            source: 'messages.0.payload.data.score',
            operator: 'gt',
            expected: 16,
        })).ok).toBe(true);
        expect((await evaluateAssert(runtime, {
            source: 'messages.0.payload.data.score',
            operator: 'between',
            expected: [17, 20],
        })).ok).toBe(true);
        expect((await evaluateAssert(runtime, {
            source: 'messages.0.payload.data.score',
            operator: 'between',
            expected: [18, 20],
        })).ok).toBe(false);
        expect((await evaluateAssert(runtime, {
            source: 'messages.0.payload.data.score',
            operator: 'between',
            expected: [17],
        })).ok).toBe(false);
        expect((await evaluateAssert(runtime, {
            source: 'messages.0.payload.data.items',
            operator: 'length',
            expected: 3,
        })).ok).toBe(true);
        expect((await evaluateAssert(runtime, {
            source: 'messages.0.payload.data.marker',
            operator: 'length',
            expected: 'assert-operators'.length,
        })).ok).toBe(true);
        expect((await evaluateAssert(runtime, {
            source: 'messages.0.payload.data.score',
            operator: 'length',
            expected: 2,
        })).ok).toBe(true);
        expect((await evaluateAssert(runtime, {
            source: 'messages.0.payload.data.marker',
            operator: 'matches',
            expected: '^assert-',
        })).ok).toBe(true);
        expect((await evaluateAssert(runtime, {
            source: 'messages.0.payload.data.marker',
            operator: 'matches',
            expected: '^[invalid',
        })).ok).toBe(false);
        expect((await evaluateAssert(runtime, {
            source: 'messages.0.payload.data.items',
            operator: 'matches',
            expected: 'alpha',
        })).ok).toBe(false);
    });

    it('evaluates shape operators on lastResult and resultCache roots', async () => {
        const runtime = createDeterministicRuntime();
        await runtime.execute({
            kind: 'http.request',
            commandId: 'shape-source-http',
            request: { url: 'https://api.example.test' },
        });

        const cacheShape = await evaluateAssert(runtime, {
            source: 'resultCache.shape-source-http.value',
            operator: 'matchesShape',
            expected: {
                fake: true,
                kind: 'http.request',
            },
        });
        expect(cacheShape.ok).toBe(true);

        const lastResultShape = await evaluateAssert(runtime, {
            source: 'lastResult.value',
            operator: 'matchesShape',
            expected: {
                fake: true,
                kind: 'ws.send',
            },
        });
        expect(lastResultShape.ok).toBe(false);
    });

    it('rejects an unexpected array element with matchesShapeComplete', async () => {
        const runtime = createDeterministicRuntime();
        runtime.recordEvent({
            kind: 'message',
            topic: 'room.assert.shape',
            payload: {
                data: {
                    topic: 'room.assert.shape',
                    items: ['expected-item', 'unexpected-item'],
                },
            },
        });

        const compatible = await evaluateAssert(runtime, {
            source: 'messages.0.payload.data',
            operator: 'matchesShape',
            expected: {
                items: ['expected-item'],
            },
        });
        expect(compatible.ok).toBe(true);

        const complete = await evaluateAssert(runtime, {
            source: 'messages.0.payload.data',
            operator: 'matchesShapeComplete',
            expected: {
                topic: 'room.assert.shape',
                items: ['expected-item'],
            },
        });
        expect(complete.ok).toBe(false);
        expect(complete.passed).toBe(false);

        const completeExact = await evaluateAssert(runtime, {
            source: 'messages.0.payload.data',
            operator: 'matchesShapeComplete',
            expected: {
                topic: 'room.assert.shape',
                items: ['expected-item', 'unexpected-item'],
            },
        });
        expect(completeExact.ok).toBe(true);
    });

    it('redacts sensitive actual values in failing assert details', async () => {
        const runtime = createDeterministicRuntime();
        runtime.recordEvent({
            kind: 'message',
            topic: 'room.assert.secret',
            payload: {
                data: {
                    accessToken: 'live-secret-value',
                },
            },
        });

        const result = await runtime.execute({
            kind: 'assert',
            commandId: 'assert-secret-shape',
            source: 'messages.0.payload.data',
            operator: 'matchesShape',
            expected: {
                accessToken: 'value-that-cannot-match',
            },
        });

        expect(result.ok).toBe(false);
        const value = result.value as RallarBlackBoxTestAssertResultValue;
        expect((value.actual as { accessToken: string }).accessToken).toBe('<redacted>');
        const details = result.error?.details as { actual: { accessToken: string } };
        expect(details.actual.accessToken).toBe('<redacted>');
    });

    it('keeps the historical six operators and their quirks untouched', async () => {
        const runtime = createDeterministicRuntime();

        const missingPathNotEquals = await evaluateAssert(runtime, {
            source: 'state.missing.path',
            operator: 'notEquals',
            expected: 'anything',
        });
        expect(missingPathNotEquals.ok).toBe(true);

        runtime.recordEvent({
            kind: 'message',
            topic: 'room.assert.quirks',
            payload: { data: { score: '17' } },
        });
        const stringGte = await evaluateAssert(runtime, {
            source: 'messages.0.payload.data.score',
            operator: 'gte',
            expected: 17,
        });
        expect(stringGte.ok).toBe(false);
    });

    it('validates the widened operator enum at every boundary', () => {
        for (const operator of ['gt', 'lt', 'between', 'length', 'matches', 'matchesShape', 'matchesShapeComplete']) {
            expect(validateRallarBlackBoxTestCommand({
                kind: 'assert',
                commandId: `assert-${operator}`,
                source: 'state.messages.length',
                operator,
                expected: 1,
            } as never)).toEqual({ ok: true });

            expect(validateJsonSchema(RALLAR_BLACK_BOX_TEST_COMMAND_SCHEMA, {
                kind: 'assert',
                commandId: `assert-${operator}`,
                source: 'state.messages.length',
                operator,
                expected: 1,
            }).ok).toBe(true);
        }

        expect(validateRallarBlackBoxTestCommand({
            kind: 'assert',
            commandId: 'assert-unknown',
            source: 'state.messages.length',
            operator: 'matchesShapeExact',
        } as never).ok).toBe(false);

        expect(validateJsonSchema(RALLAR_BLACK_BOX_TEST_COMMAND_SCHEMA, {
            kind: 'assert',
            commandId: 'assert-unknown',
            source: 'state.messages.length',
            operator: 'matchesShapeExact',
        }).ok).toBe(false);
    });
});
