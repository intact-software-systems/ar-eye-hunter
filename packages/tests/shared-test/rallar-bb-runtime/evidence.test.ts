import * as timers from 'node:timers/promises';
import { describe, expect, it } from 'vitest';
import {
    createRallarBlackBoxTestRuntime,
    type RallarBlackBoxTestAssertResultValue,
    type RallarBlackBoxTestWaitResultValue
} from '../../../shared-test/rallar-bb-test/mod.ts';
import { createDeterministicRuntime } from './create-deterministic-runtime.ts';

describe('rallar-bb runtime evidence', () => {
    it('waits against already-recorded runtime events with payload path equals and exists matches', async () => {
        const runtime = createDeterministicRuntime();
        runtime.recordEvent({
            kind: 'message',
            topic: 'rallar.browser.realtime.message',
            connection: 'roomRtc',
            transport: 'realtime',
            severity: 'info',
            payload: {
                data: {
                    topic: 'room.position',
                    x: 10
                }
            }
        });

        const result = await runtime.execute({
            kind: 'wait',
            commandId: 'wait-position-now',
            timeoutMs: 100,
            match: {
                kind: 'message',
                topic: 'rallar.browser.realtime.message',
                connection: 'roomRtc',
                transport: 'realtime',
                payloadPath: 'data.topic',
                equals: 'room.position',
                exists: true
            }
        });
        const value = result.value as RallarBlackBoxTestWaitResultValue;

        expect(result.ok).toBe(true);
        expect(value.matched).toBe(true);
        expect(value.event?.topic).toBe('rallar.browser.realtime.message');
        expect(value.event?.payload).toEqual({
            data: {
                topic: 'room.position',
                x: 10
            }
        });
    });

    it('waits for future runtime events with payload contains matches', async () => {
        const runtime = createRallarBlackBoxTestRuntime();
        const wait = runtime.execute({
            kind: 'wait',
            commandId: 'wait-position-future',
            timeoutMs: 200,
            match: {
                kind: 'message',
                topic: 'rallar.browser.realtime.message',
                payloadPath: 'data.text',
                contains: 'future-position'
            }
        });

        await timers.setTimeout(10);
        runtime.recordEvent({
            kind: 'message',
            topic: 'rallar.browser.realtime.message',
            transport: 'realtime',
            payload: {
                data: {
                    text: 'hello future-position payload'
                }
            }
        });
        const result = await wait;
        const value = result.value as RallarBlackBoxTestWaitResultValue;

        expect(result.ok).toBe(true);
        expect(value.matched).toBe(true);
        expect(value.event?.payload).toEqual({
            data: {
                text: 'hello future-position payload'
            }
        });
    });

    it('fails wait commands when the requested evidence times out', async () => {
        const runtime = createRallarBlackBoxTestRuntime();

        const result = await runtime.execute({
            kind: 'wait',
            commandId: 'wait-timeout',
            timeoutMs: 5,
            match: {
                kind: 'message',
                topic: 'missing-message'
            }
        });
        const value = result.value as RallarBlackBoxTestWaitResultValue;

        expect(result.status).toBe('failed');
        expect(result.error?.code).toBe('RALLAR_BLACK_BOX_WAIT_TIMEOUT');
        expect(value.matched).toBe(false);
        expect(value.timedOut).toBe(true);
    });

    it('cancels pending wait commands when recipe cancellation is requested', async () => {
        const runtime = createRallarBlackBoxTestRuntime();
        const wait = runtime.execute({
            kind: 'wait',
            commandId: 'wait-cancelled',
            timeoutMs: 200,
            match: {
                kind: 'message',
                topic: 'never-delivered'
            }
        });

        await timers.setTimeout(10);
        await runtime.execute({
            kind: 'recipe.cancel',
            commandId: 'cancel-wait',
            reason: 'operator requested stop'
        });
        const result = await wait;
        const value = result.value as RallarBlackBoxTestWaitResultValue;

        expect(result.status).toBe('cancelled');
        expect(value.cancelled).toBe(true);
        expect(value.matched).toBe(false);
    });

    it('redacts matched wait events in command results', async () => {
        const runtime = createDeterministicRuntime();

        await runtime.execute({
            kind: 'configure',
            commandId: 'configure-wait-redaction',
            config: {
                redaction: {
                    secretValues: ['event-secret']
                }
            }
        });
        runtime.recordEvent({
            kind: 'message',
            topic: 'secure-message',
            payload: {
                data: {
                    topic: 'secure',
                    token: 'event-secret'
                }
            }
        });
        const result = await runtime.execute({
            kind: 'wait',
            commandId: 'wait-secure-message',
            match: {
                kind: 'message',
                topic: 'secure-message',
                payloadPath: 'data.topic',
                equals: 'secure'
            }
        });
        const value = result.value as RallarBlackBoxTestWaitResultValue;

        expect(result.ok).toBe(true);
        expect(value.event?.payload).toEqual({
            data: {
                topic: 'secure',
                token: '<redacted>'
            }
        });
    });

    it('passes assert commands against runtime state message counts', async () => {
        const runtime = createDeterministicRuntime();
        runtime.recordEvent({
            kind: 'message',
            topic: 'rallar.browser.realtime.message',
            payload: {
                data: {
                    topic: 'room.position'
                }
            }
        });

        const result = await runtime.execute({
            kind: 'assert',
            commandId: 'assert-message-count',
            source: 'state.messages.length',
            operator: 'gte',
            expected: 1
        });
        const value = result.value as RallarBlackBoxTestAssertResultValue;

        expect(result.ok).toBe(true);
        expect(value).toMatchObject({
            commandId: 'assert-message-count',
            source: 'state.messages.length',
            operator: 'gte',
            expected: 1,
            actual: 1,
            exists: true,
            passed: true
        });
    });

    it('fails assert commands with redacted actual and expected details', async () => {
        const runtime = createDeterministicRuntime();

        await runtime.execute({
            kind: 'configure',
            commandId: 'configure-assert-redaction',
            config: {
                redaction: {
                    secretValues: ['assert-secret']
                }
            }
        });
        runtime.recordEvent({
            kind: 'message',
            topic: 'secure-message',
            payload: {
                data: {
                    text: 'assert-secret'
                }
            }
        });

        const result = await runtime.execute({
            kind: 'assert',
            commandId: 'assert-secret-message',
            source: 'messages.0.payload.data.text',
            operator: 'equals',
            expected: 'different assert-secret'
        });
        const value = result.value as RallarBlackBoxTestAssertResultValue;

        expect(result.status).toBe('failed');
        expect(result.error?.code).toBe('RALLAR_BLACK_BOX_ASSERT_FAILED');
        expect(value).toMatchObject({
            actual: '<redacted>',
            expected: '<redacted>',
            exists: true,
            passed: false
        });
        expect(result.error?.details).toMatchObject({
            actual: '<redacted>',
            expected: '<redacted>'
        });
    });

    it('asserts missing paths with the exists operator', async () => {
        const runtime = createDeterministicRuntime();

        const result = await runtime.execute({
            kind: 'assert',
            commandId: 'assert-missing-path',
            source: 'config.rallar.missingToken',
            operator: 'exists',
            expected: false
        });
        const value = result.value as RallarBlackBoxTestAssertResultValue;

        expect(result.ok).toBe(true);
        expect(value).toMatchObject({
            exists: false,
            passed: true
        });
    });

    it('fails non-exists assertions for missing paths', async () => {
        const runtime = createDeterministicRuntime();

        const result = await runtime.execute({
            kind: 'assert',
            commandId: 'assert-missing-equals',
            source: 'state.messages.0.payload.data.topic',
            operator: 'equals',
            expected: 'room.position'
        });
        const value = result.value as RallarBlackBoxTestAssertResultValue;

        expect(result.status).toBe('failed');
        expect(result.error?.code).toBe('RALLAR_BLACK_BOX_ASSERT_FAILED');
        expect(value.exists).toBe(false);
        expect(value.passed).toBe(false);
    });

    it('asserts nested values and last command results', async () => {
        const runtime = createDeterministicRuntime();

        runtime.recordEvent({
            kind: 'message',
            topic: 'nested-message',
            payload: {
                data: {
                    position: {
                        x: 4
                    },
                    tags: ['position', 'live']
                }
            }
        });
        const nestedResult = await runtime.execute({
            kind: 'assert',
            commandId: 'assert-nested-position',
            source: 'recentMessages.0.payload.data.position.x',
            operator: 'lte',
            expected: 5
        });
        const lastResult = await runtime.execute({
            kind: 'assert',
            commandId: 'assert-last-result',
            source: 'lastResult.value.actual',
            operator: 'equals',
            expected: 4
        });
        const containsResult = await runtime.execute({
            kind: 'assert',
            commandId: 'assert-tag-contains',
            source: 'messages.0.payload.data.tags',
            operator: 'contains',
            expected: 'live'
        });

        expect(nestedResult.ok).toBe(true);
        expect(lastResult.ok).toBe(true);
        expect(containsResult.ok).toBe(true);
    });
});
