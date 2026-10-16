import { describe, expect, it } from 'vitest';
import { validateRallarBlackBoxTestCommand } from '../../shared-test/rallar-bb-test/control/validate-rallar-black-box-test-command.ts';
import type { RallarBlackBoxTestEvent, RallarBlackBoxTestWaitCommand } from '../../shared-test/rallar-bb-test/rallar-black-box-test-contracts.ts';
import { createDefaultRallarBlackBoxTestRuntime } from '../../shared-test/rallar-bb-test/runtime/create-rallar-black-box-test-runtime.ts';
import { decodeRecord } from '../../shared-test/rallar-bb-test/runtime/decode-runtime-result-values.ts';
import { createEventHistory, type RallarBlackBoxEventHistory } from '../../shared-test/rallar-bb-test/runtime/event-history.ts';
import { RALLAR_BLACK_BOX_TEST_COMMAND_SCHEMA } from '../../shared-test/rallar-bb-test/schema.ts';
import { formatJsonSchemaValidationErrors, validateJsonSchema } from '../../shared-test/rallar-bb-test/schema/json-schema-validation.ts';
import { waitForEvent } from '../../shared-test/rallar-bb-test/wait/wait-for-event.ts';

function sleepMs(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

interface CountedEventSource {
    readonly events: () => readonly RallarBlackBoxTestEvent[];
    readonly history: () => RallarBlackBoxEventHistory;
    readonly reads: () => number;
    readonly append: (event: RallarBlackBoxTestEvent) => void;
    readonly subscribe: (
        listener: (events: readonly RallarBlackBoxTestEvent[], history: RallarBlackBoxEventHistory) => void
    ) => () => void;
}

/** Counts every indexed read of the retained events a wait is handed, the matching work an event costs it. */
function createCountedEventSource(retainedCount: number): CountedEventSource {
    let reads = 0;
    let retained = Array.from({ length: retainedCount }, (_, index) => toNoiseEvent(index));
    const listeners = new Set<(events: readonly RallarBlackBoxTestEvent[], history: RallarBlackBoxEventHistory) => void>();
    const counted = (events: RallarBlackBoxTestEvent[]): readonly RallarBlackBoxTestEvent[] =>
        new Proxy(events, {
            get: (target, key, receiver) => {
                if (typeof key === 'string' && /^\d+$/.test(key)) {
                    reads += 1;
                }
                return Reflect.get(target, key, receiver);
            }
        });
    const history = (): RallarBlackBoxEventHistory => ({
        ...createEventHistory({ mode: 'full' }, { runtimeId: 'runtime-1', generation: 1 }, { status: 'unattached' }),
        totalEvents: retained.length,
        retainedEvents: retained.length
    });
    return {
        events: () => counted(retained),
        history,
        reads: () => reads,
        append: (event) => {
            retained = [...retained, event];
            listeners.forEach((listener) => listener(counted(retained), history()));
        },
        subscribe: (listener) => {
            listeners.add(listener);
            listener(counted(retained), history());
            return () => listeners.delete(listener);
        }
    };
}

function toNoiseEvent(index: number): RallarBlackBoxTestEvent {
    return { eventId: `noise-${index}`, kind: 'diagnostic', topic: 'rallar.browser.noise', atEpochMs: 1_000 + index, severity: 'info' };
}

function startCountedWait(source: CountedEventSource, command: RallarBlackBoxTestWaitCommand & { commandId: string; }) {
    const cancellation = new AbortController();
    const outcome = waitForEvent({
        command,
        now: () => 1_000,
        sleep: (_ms, signal) => new Promise((_resolve, reject) => signal?.addEventListener('abort', () => reject(new Error('aborted')))),
        cancellationSignal: cancellation.signal,
        cancelRequested: () => cancellation.signal.aborted,
        currentStatus: () => 'running',
        currentEvents: source.events,
        currentEventHistory: source.history,
        resultCache: {},
        subscribe: source.subscribe
    });
    return { outcome, cancel: () => cancellation.abort() };
}

describe('rallar-bb-test wait absence', () => {
    // A wait scans the whole buffer and answers with the newest match, so a scenario that
    // legitimately produced the same event earlier — a stage the group passed through before, a
    // dial before a reset — needs the cursor to say which occurrence it means.
    it('ignores matching events recorded before the cursor', async () => {
        let now = 1_000;
        const runtime = createDefaultRallarBlackBoxTestRuntime({
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
        const runtime = createDefaultRallarBlackBoxTestRuntime({
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
        const runtime = createDefaultRallarBlackBoxTestRuntime({
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

        expect(result.ok).toBe(true);
        expect(result.value).toHaveProperty('matched', false);
        expect(result.value).toHaveProperty('absent', true);
        expect(decodeRecord(result.value).event).toBeUndefined();
        expect(sleptDurations).toEqual([2_000]);
        expect(now).toBe(3_000);
    });

    it('fails with the offending event when a matching event was already buffered', async () => {
        let now = 1_000;
        const runtime = createDefaultRallarBlackBoxTestRuntime({
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

        expect(result.status).toBe('failed');
        expect(result.error?.code).toBe('RALLAR_BLACK_BOX_WAIT_ABSENCE_VIOLATED');
        expect(result.value).toHaveProperty('matched', true);
        expect(result.value).toHaveProperty('absent', true);
        expect(result.value).toHaveProperty('event.topic', 'room.forbidden-topic');
    });

    it('fails when the matching event arrives during the held window', async () => {
        let now = 1_000;
        let releaseHold: (() => void) | undefined;
        const runtime = createDefaultRallarBlackBoxTestRuntime({
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

        expect(result.status).toBe('failed');
        expect(result.error?.code).toBe('RALLAR_BLACK_BOX_WAIT_ABSENCE_VIOLATED');
        expect(result.value).toHaveProperty('matched', true);
        expect(result.value).toHaveProperty('event.payload.data.accessToken', '<redacted>');
        expect(result.error?.details).toHaveProperty('event.payload.data.accessToken', '<redacted>');
    });

    it('cancels an absence hold when recipe cancellation is requested', async () => {
        const runtime = createDefaultRallarBlackBoxTestRuntime();
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

        expect(result.status).toBe('cancelled');
        expect(result.value).toHaveProperty('cancelled', true);
        expect(result.value).toHaveProperty('absent', true);
        expect(result.value).toHaveProperty('matched', false);
    });

    it('examines only the newly admitted event in each live wait, however many events are retained', async () => {
        const source = createCountedEventSource(2_000);
        const absent = startCountedWait(source, {
            kind: 'wait',
            commandId: 'absent-forbidden',
            absent: true,
            timeoutMs: 60_000,
            match: { kind: 'message', topic: 'room.forbidden-topic' }
        });
        const present = startCountedWait(source, {
            kind: 'wait',
            commandId: 'present-ready',
            timeoutMs: 60_000,
            match: { kind: 'message', topic: 'room.ready', payloadPath: 'marker', contains: 'go' }
        });
        await Promise.resolve();
        const readsBeforeEvent = source.reads();

        source.append({ ...toNoiseEvent(2_000), topic: 'rallar.browser.other-noise' });

        expect(source.reads() - readsBeforeEvent).toBeLessThanOrEqual(4);
        source.append({ eventId: 'ready', kind: 'message', topic: 'room.ready', atEpochMs: 4_000, severity: 'info', payload: { marker: 'go' } });
        expect((await present.outcome).status).toBe('ok');
        absent.cancel();
        expect((await absent.outcome).status).toBe('cancelled');
    });

    it('rejects absent values other than true at the runtime boundary', async () => {
        const runtime = createDefaultRallarBlackBoxTestRuntime();
        const result = await runtime.execute({
            kind: 'wait',
            commandId: 'absence-invalid-flag',
            // @ts-expect-error Deliberately exercise an invalid JavaScript absence flag.
            absent: false,
            match: {
                kind: 'message',
                topic: 'room.forbidden-topic'
            }
        });

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
        })).toEqual({
            ok: false,
            error: 'wait.absent must be true when present.',
            messages: ['wait.absent must be true when present.']
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

describe('rallar-bb-test wait timeout counted from an earlier epoch', () => {
    const ACCEPTED_AT_REFERENCE = '{resultCache.readiness.value.formation.accepted.overlay.updatedAtEpochMs}';

    function createRuntimeWithAcceptedLayout(acceptedAtEpochMs: number) {
        const clock = { now: 10_000, sleptDurations: [] as number[] };
        const runtime = createDefaultRallarBlackBoxTestRuntime({
            now: () => clock.now,
            sleep: async (ms) => {
                clock.sleptDurations.push(ms);
                clock.now += ms;
            },
            commandExecutor: (command) =>
                command.kind === 'formation.readiness'
                    ? {
                        status: 'ok',
                        value: { formation: { accepted: { overlay: { updatedAtEpochMs: acceptedAtEpochMs } } } }
                    }
                    : undefined
        });
        return { runtime, clock };
    }

    function toQuietWait(commandId: string, timeoutFrom: string): RallarBlackBoxTestWaitCommand {
        return {
            kind: 'wait',
            commandId,
            absent: true,
            timeoutMs: 3_500,
            timeoutFrom,
            match: { kind: 'diagnostic', topic: 'rallar.browser.formation.layout' }
        };
    }

    async function readAcceptedLayout(runtime: ReturnType<typeof createRuntimeWithAcceptedLayout>['runtime']) {
        await runtime.execute({ kind: 'formation.readiness', commandId: 'readiness', timeoutMs: 1_000 });
    }

    // A layout accepted 1.2 s ago has already been quiet that long, so only the rest of the window is held.
    it('holds an absence only for the part of the window still to come', async () => {
        const { runtime, clock } = createRuntimeWithAcceptedLayout(8_800);
        await readAcceptedLayout(runtime);

        const result = await runtime.execute(toQuietWait('quiet-rest', ACCEPTED_AT_REFERENCE));

        expect(result.status).toBe('ok');
        expect(result.value).toEqual({ matched: false, absent: true });
        expect(clock.sleptDurations).toEqual([2_300]);
    });

    it('closes at once when the window ended before the wait, yet still fails on a buffered match', async () => {
        const settled = createRuntimeWithAcceptedLayout(1_000);
        await readAcceptedLayout(settled.runtime);
        const quiet = await settled.runtime.execute(toQuietWait('quiet-settled', ACCEPTED_AT_REFERENCE));

        const replanned = createRuntimeWithAcceptedLayout(1_000);
        await readAcceptedLayout(replanned.runtime);
        replanned.runtime.recordEvent({ kind: 'diagnostic', topic: 'rallar.browser.formation.layout' });
        const violated = await replanned.runtime.execute(toQuietWait('quiet-replanned', ACCEPTED_AT_REFERENCE));

        expect(quiet.status).toBe('ok');
        expect(settled.clock.sleptDurations).toEqual([0]);
        expect(violated.status).toBe('failed');
        expect(violated.error?.code).toBe('RALLAR_BLACK_BOX_WAIT_ABSENCE_VIOLATED');
    });

    // An epoch ahead of the agent's clock never lengthens the wait beyond its own timeout.
    it('counts from the wait start when the referenced epoch lies ahead of it', async () => {
        const { runtime, clock } = createRuntimeWithAcceptedLayout(10_400);
        await readAcceptedLayout(runtime);

        const result = await runtime.execute(toQuietWait('quiet-ahead', ACCEPTED_AT_REFERENCE));

        expect(result.status).toBe('ok');
        expect(clock.sleptDurations).toEqual([3_500]);
    });

    it('refuses a timeoutFrom that names no numeric result value', async () => {
        const { runtime } = createRuntimeWithAcceptedLayout(8_800);
        await readAcceptedLayout(runtime);

        const missing = await runtime.execute(
            toQuietWait('quiet-missing', '{resultCache.readiness.value.formation.planned.overlay.updatedAtEpochMs}')
        );
        const textual = await runtime.execute(toQuietWait('quiet-text', 'at {resultCache.readiness.value.formation}'));

        expect(missing.error).toMatchObject({
            code: 'RALLAR_BLACK_BOX_WAIT_INVALID',
            details: { reference: 'resultCache.readiness.value.formation.planned.overlay.updatedAtEpochMs' }
        });
        expect(textual.error).toMatchObject({
            code: 'RALLAR_BLACK_BOX_WAIT_INVALID',
            details: { timeoutFrom: 'at {resultCache.readiness.value.formation}' }
        });
    });

    it('publishes timeoutFrom through the command schema and the control validation', () => {
        const command = toQuietWait('quiet-schema', ACCEPTED_AT_REFERENCE);

        expect(validateRallarBlackBoxTestCommand(command)).toEqual({ ok: true });
        expect(formatJsonSchemaValidationErrors(validateJsonSchema(RALLAR_BLACK_BOX_TEST_COMMAND_SCHEMA, command).errors))
            .toBe('');
        expect(validateRallarBlackBoxTestCommand({ ...command, timeoutFrom: 7 })).toMatchObject({
            ok: false,
            error: 'wait.timeoutFrom must be a string.'
        });
    });
});
