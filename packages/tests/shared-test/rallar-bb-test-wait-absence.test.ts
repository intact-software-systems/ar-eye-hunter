import { describe, expect, it } from 'vitest';
import { validateRallarBlackBoxTestCommand } from '../../shared-test/rallar-bb-test/control-protocol.ts';
import { createRallarBlackBoxTestRuntime } from '../../shared-test/rallar-bb-test/runtime.ts';
import { formatJsonSchemaValidationErrors, RALLAR_BLACK_BOX_TEST_COMMAND_SCHEMA, validateJsonSchema } from '../../shared-test/rallar-bb-test/schema.ts';
import type { RallarBlackBoxTestWaitResultValue } from '../../shared-test/rallar-bb-test/types.ts';

function sleepMs(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

describe('rallar-bb-test wait absence', () => {
    // A wait scans the whole buffer and answers with the newest match, so a scenario that
    // legitimately produced the same event earlier — a stage the group passed through before, a
    // dial before a reset — needs the cursor to say which occurrence it means.
    it('ignores matching events recorded before the cursor', async () => {
        let now = 1_000;
        const runtime = createRallarBlackBoxTestRuntime({
            now: () => now,
            sleep: async (ms) => {
                now += ms;
            }
        });

        runtime.recordEvent({
            kind: 'diagnostic',
            topic: 'rallar.browser.formation.changed',
            payload: { data: { stage: 'dormant' } }
        });
        now = 2_000;

        const result = await runtime.execute({
            kind: 'wait',
            commandId: 'wait-since-cursor',
            timeoutMs: 20,
            match: {
                kind: 'diagnostic',
                topic: 'rallar.browser.formation.changed',
                sinceEpochMs: 2_000
            }
        });

        expect(result.status).toBe('failed');
    });

    it('accepts a matching event recorded at the cursor', async () => {
        let now = 2_000;
        const runtime = createRallarBlackBoxTestRuntime({
            now: () => now,
            sleep: async (ms) => {
                now += ms;
            }
        });

        runtime.recordEvent({
            kind: 'diagnostic',
            topic: 'rallar.browser.formation.changed',
            payload: { data: { stage: 'dormant' } }
        });

        const result = await runtime.execute({
            kind: 'wait',
            commandId: 'wait-since-cursor-inclusive',
            timeoutMs: 20,
            match: {
                kind: 'diagnostic',
                topic: 'rallar.browser.formation.changed',
                sinceEpochMs: 2_000
            }
        });

        expect(result.status).toBe('ok');
    });

    it('publishes the cursor through the command schema and the control validation', () => {
        const command = {
            kind: 'wait',
            commandId: 'wait-since-cursor-schema',
            timeoutMs: 1_000,
            match: { kind: 'diagnostic', topic: 'rallar.browser.formation.ready', sinceEpochMs: 42 }
        } as const;

        const schemaResult = validateJsonSchema(RALLAR_BLACK_BOX_TEST_COMMAND_SCHEMA, command);

        expect(validateRallarBlackBoxTestCommand(command)).toEqual({ ok: true });
        expect(formatJsonSchemaValidationErrors(schemaResult.errors)).toBe('');
    });

    it('holds the full window and succeeds when nothing matches', async () => {
        let now = 1_000;
        const sleptDurations: number[] = [];
        const runtime = createRallarBlackBoxTestRuntime({
            now: () => now,
            sleep: async (ms) => {
                sleptDurations.push(ms);
                now += ms;
            }
        });

        runtime.recordEvent({
            kind: 'message',
            topic: 'room.other-topic',
            payload: { data: { topic: 'room.allowed' } }
        });

        const result = await runtime.execute({
            kind: 'wait',
            commandId: 'absence-holds',
            absent: true,
            timeoutMs: 2_000,
            match: {
                kind: 'message',
                topic: 'room.forbidden-topic'
            }
        });

        const value = result.value as RallarBlackBoxTestWaitResultValue;
        expect(result.ok).toBe(true);
        expect(value.matched).toBe(false);
        expect(value.absent).toBe(true);
        expect(value.event).toBeUndefined();
        expect(sleptDurations).toEqual([2_000]);
        expect(now).toBe(3_000);
    });

    it('fails with the offending event when a matching event was already buffered', async () => {
        let now = 1_000;
        const runtime = createRallarBlackBoxTestRuntime({
            now: () => now,
            sleep: async (ms) => {
                now += ms;
            }
        });

        runtime.recordEvent({
            kind: 'message',
            topic: 'room.forbidden-topic',
            payload: { data: { marker: 'leaked-before-wait' } }
        });

        const result = await runtime.execute({
            kind: 'wait',
            commandId: 'absence-violated-buffered',
            absent: true,
            timeoutMs: 1_000,
            match: {
                kind: 'message',
                topic: 'room.forbidden-topic'
            }
        });

        const value = result.value as RallarBlackBoxTestWaitResultValue;
        expect(result.status).toBe('failed');
        expect(result.error?.code).toBe('RALLAR_BLACK_BOX_WAIT_ABSENCE_VIOLATED');
        expect(value.matched).toBe(true);
        expect(value.absent).toBe(true);
        expect(value.event?.topic).toBe('room.forbidden-topic');
    });

    it('fails when the matching event arrives during the held window', async () => {
        let now = 1_000;
        let releaseHold: (() => void) | undefined;
        const runtime = createRallarBlackBoxTestRuntime({
            now: () => now,
            sleep: (ms) =>
                new Promise<void>((resolve) => {
                    releaseHold = () => {
                        now += ms;
                        resolve();
                    };
                })
        });

        const pending = runtime.execute({
            kind: 'wait',
            commandId: 'absence-violated-during-window',
            absent: true,
            timeoutMs: 1_000,
            match: {
                kind: 'message',
                topic: 'room.forbidden-topic',
                payloadPath: 'data.secretName',
                exists: true
            }
        });

        await sleepMs(5);
        runtime.recordEvent({
            kind: 'message',
            topic: 'room.forbidden-topic',
            payload: {
                data: {
                    secretName: 'leaked-during-window',
                    accessToken: 'live-leak-token'
                }
            }
        });
        expect(releaseHold).toBeDefined();
        releaseHold?.();

        const result = await pending;
        const value = result.value as RallarBlackBoxTestWaitResultValue;
        expect(result.status).toBe('failed');
        expect(result.error?.code).toBe('RALLAR_BLACK_BOX_WAIT_ABSENCE_VIOLATED');
        expect(value.matched).toBe(true);
        expect((value.event?.payload as { data: { accessToken: string; }; }).data.accessToken)
            .toBe('<redacted>');
        const details = result.error?.details as { event: { payload: { data: { accessToken: string; }; }; }; };
        expect(details.event.payload.data.accessToken).toBe('<redacted>');
    });

    it('cancels an absence hold when recipe cancellation is requested', async () => {
        const runtime = createRallarBlackBoxTestRuntime();
        const pending = runtime.execute({
            kind: 'wait',
            commandId: 'absence-cancelled',
            absent: true,
            timeoutMs: 500,
            match: {
                kind: 'message',
                topic: 'room.forbidden-topic'
            }
        });

        await sleepMs(10);
        await runtime.execute({
            kind: 'recipe.cancel',
            commandId: 'cancel-absence-hold',
            reason: 'operator requested stop'
        });

        const result = await pending;
        const value = result.value as RallarBlackBoxTestWaitResultValue;
        expect(result.status).toBe('cancelled');
        expect(value.cancelled).toBe(true);
        expect(value.absent).toBe(true);
        expect(value.matched).toBe(false);
    });

    it('rejects absent values other than true at the runtime boundary', async () => {
        const runtime = createRallarBlackBoxTestRuntime();
        const result = await runtime.execute({
            kind: 'wait',
            commandId: 'absence-invalid-flag',
            absent: false,
            match: {
                kind: 'message',
                topic: 'room.forbidden-topic'
            }
        } as never);

        expect(result.status).toBe('failed');
        expect(result.error?.code).toBe('RALLAR_BLACK_BOX_WAIT_INVALID');
    });

    it('validates absent at the control protocol and schema boundaries', () => {
        expect(validateRallarBlackBoxTestCommand({
            kind: 'wait',
            commandId: 'absence-protocol-valid',
            absent: true,
            timeoutMs: 1_000,
            match: {
                kind: 'message',
                topic: 'room.forbidden-topic'
            }
        })).toEqual({ ok: true });

        expect(validateRallarBlackBoxTestCommand({
            kind: 'wait',
            commandId: 'absence-protocol-invalid',
            absent: false,
            match: {
                kind: 'message',
                topic: 'room.forbidden-topic'
            }
        } as never)).toEqual({
            ok: false,
            error: 'wait.absent must be true when present.'
        });

        expect(
            validateJsonSchema(RALLAR_BLACK_BOX_TEST_COMMAND_SCHEMA, {
                kind: 'wait',
                commandId: 'absence-schema-valid',
                absent: true,
                match: {
                    kind: 'message',
                    topic: 'room.forbidden-topic'
                }
            }).ok
        ).toBe(true);

        const invalid = validateJsonSchema(RALLAR_BLACK_BOX_TEST_COMMAND_SCHEMA, {
            kind: 'wait',
            commandId: 'absence-schema-invalid',
            absent: 'yes',
            match: {
                kind: 'message',
                topic: 'room.forbidden-topic'
            }
        });
        expect(invalid.ok).toBe(false);
        if (!invalid.ok) {
            expect(formatJsonSchemaValidationErrors(invalid.errors)).toContain('$.absent: Expected true.');
        }
    });
});
