import { describe, expect, it, vi } from 'vitest';

import { AL_VOLATILE_SESSION_LIMITS } from '@shared/alm/volatile-budget/al-volatile-session-budget.ts';

import { normalizeBlackBoxResponseHeaders } from '../../shared-test/black-box-runner/http/normalize-black-box-response-headers.ts';
import { validateRallarBlackBoxTestCommand } from '../../shared-test/rallar-bb-test/control/validate-rallar-black-box-test-command.ts';
import {
    createDefaultRallarBlackBoxTestRuntime,
    createRallarBlackBoxTestRuntime,
    getRallarBlackBoxActiveCommand,
    getRallarBlackBoxCommandHistory,
    getRallarBlackBoxCurrentConfig,
    getRallarBlackBoxFailures,
    getRallarBlackBoxFirstFailure,
    getRallarBlackBoxLatestStats,
    redactRallarBlackBoxValue,
    toRallarBlackBoxDiagnostics,
    type RallarBlackBoxTestCommand,
    type RallarBlackBoxTestJsonValue,
    type RallarBlackBoxTestRecipe
} from '../../shared-test/rallar-bb-test/mod.ts';
import type { RallarBlackBoxTestAlmUsage } from '../../shared-test/rallar-bb-test/rallar-black-box-test-contracts.ts';
import { sleepWithAbort } from '../../shared-test/rallar-bb-test/runtime/sleep-with-abort.ts';
import { createDeterministicRuntime } from './rallar-bb-runtime/create-deterministic-runtime.ts';

describe('runtime construction', () => {
    it('constructs a default runtime through the public entry', async () => {
        const runtime = createDefaultRallarBlackBoxTestRuntime();
        const result = await runtime.execute({ kind: 'health' });
        expect(result.ok).toBe(true);
    });

    it('shares default IDs across prefixes and isolates runtime instances', async () => {
        const a = createDefaultRallarBlackBoxTestRuntime();
        const b = createDefaultRallarBlackBoxTestRuntime();
        a.recordEvent({ kind: 'event', topic: 'construction.first' });
        const firstA = a.state().events[0];
        const healthA = await a.execute({ kind: 'health' });
        b.recordEvent({ kind: 'event', topic: 'construction.first' });
        const firstB = b.state().events[0];
        expect(firstA.eventId).toBe('event-1');
        expect(healthA.commandId).toBe('command-2');
        expect(firstB.eventId).toBe('event-1');
    });

    it('reads the current default clock function after construction', () => {
        const original = Object.getOwnPropertyDescriptor(Date, 'now')!;
        try {
            Object.defineProperty(Date, 'now', { ...original, value: () => 1_000 });
            const runtime = createDefaultRallarBlackBoxTestRuntime();
            runtime.recordEvent({ kind: 'event', topic: 'construction.first' });
            Object.defineProperty(Date, 'now', { ...original, value: () => 2_000 });
            runtime.recordEvent({ kind: 'event', topic: 'construction.second' });
            const eventTimes = runtime.state().events.map((event) => event.atEpochMs);
            expect(eventTimes).toEqual([1_000, 2_000]);
        }
        finally {
            Object.defineProperty(Date, 'now', original);
        }
    });

    it('uses each supplied infrastructure override without replacing other defaults', async () => {
        vi.useFakeTimers();
        vi.setSystemTime(2_000);
        try {
            const clock = createDefaultRallarBlackBoxTestRuntime({ now: () => 1_000 });
            clock.recordEvent({ kind: 'event', topic: 'clock' });
            expect(clock.state().events[0]).toMatchObject({ atEpochMs: 1_000, eventId: 'event-1' });
            const ids = createDefaultRallarBlackBoxTestRuntime({ idFactory: (prefix) => `${prefix}-supplied` });
            ids.recordEvent({ kind: 'event', topic: 'ids' });
            expect(ids.state().events[0]).toMatchObject({ eventId: 'event-supplied', atEpochMs: 2_000 });
            expect((await ids.execute({ kind: 'health' })).commandId).toBe('command-supplied');
            const sleptMs: number[] = [];
            const sleeper = createDefaultRallarBlackBoxTestRuntime({
                sleep: async (ms) => {
                    sleptMs.push(ms);
                }
            });
            const loop = await sleeper.execute({ kind: 'loop', count: 2, intervalMs: 10, commands: [{ kind: 'health' }] });
            expect(sleptMs).toEqual([10]);
            expect(loop).toMatchObject({ ok: true, value: { iterations: 2, passed: 2 } });
            expect(sleeper.state().events[0].atEpochMs).toBe(2_000);
        }
        finally {
            vi.useRealTimers();
        }
    });

    it.each([
        { name: 'explicit', create: createRallarBlackBoxTestRuntime },
        { name: 'default', create: createDefaultRallarBlackBoxTestRuntime }
    ])('snapshots every supplied dependency for explicit and default construction: $name', async ({ create }) => {
        let sequence = 1;
        const sleptMs: number[] = [];
        const resources: string[] = [];
        const initialLedger: RallarBlackBoxTestAlmUsage = {
            usage: { admissions: 3, bytes: 912, oldestAgeMs: 1_250, tracks: 2 },
            own: { admissions: 2, bytes: 600 },
            inbound: { admissions: 1, bytes: 312 },
            orderingTracks: 3,
            limits: AL_VOLATILE_SESSION_LIMITS,
            overloaded: false
        };
        const initialCongestion = { dropped: 2, deferred: 3, handedOver: 4 };
        const input = {
            now: () => 1_000,
            sleep: async (ms: number) => {
                sleptMs.push(ms);
            },
            idFactory: (prefix: string) => `${prefix}-initial-${sequence++}`,
            commandExecutor: (command: RallarBlackBoxTestCommand) =>
                command.kind === 'rtc.send'
                    ? { status: 'ok' as const, value: { owner: 'initial' } }
                    : undefined,
            cleanup: async () => {
                resources.push('initial');
            },
            readAlmUsage: async () => initialLedger,
            readCongestionCounters: async () => initialCongestion
        };
        const runtime = create(input);
        input.now = () => 2_000;
        input.sleep = async () => {
            sleptMs.push(-1);
        };
        input.idFactory = (prefix) => `${prefix}-replacement`;
        input.commandExecutor = () => ({ status: 'ok', value: { owner: 'replacement' } });
        input.cleanup = async () => {
            resources.push('replacement');
        };
        input.readAlmUsage = async () => ({ ...initialLedger, usage: { admissions: 99, bytes: 99, oldestAgeMs: 99, tracks: 99 } });
        input.readCongestionCounters = async () => ({ dropped: 99, deferred: 99, handedOver: 99 });
        runtime.recordEvent({ kind: 'event', topic: 'snapshot' });
        expect(runtime.state().events[0]).toMatchObject({ atEpochMs: 1_000, eventId: 'event-initial-1' });
        expect((await runtime.execute({ kind: 'health' })).commandId).toBe('command-initial-2');
        const loop = await runtime.execute({ kind: 'loop', commandId: 'loop', count: 2, intervalMs: 10, commands: [{ kind: 'health' }] });
        expect(loop).toMatchObject({ ok: true, value: { iterations: 2, passed: 2 } });
        expect(sleptMs).toEqual([10]);
        expect((await runtime.execute({ kind: 'rtc.send', commandId: 'send', send: {} })).value).toEqual({ owner: 'initial' });
        const stats = await runtime.execute({ kind: 'stats', commandId: 'stats' });
        expect(stats.value).toMatchObject({ rallar: { alm: initialLedger, congestion: initialCongestion } });
        await runtime.execute({ kind: 'recipe.cancel', commandId: 'cleanup' });
        expect(resources).toEqual(['initial']);
    });

    it.each([
        { name: 'explicit', create: createRallarBlackBoxTestRuntime },
        { name: 'default', create: createDefaultRallarBlackBoxTestRuntime }
    ])('keeps absent optional capabilities absent: $name', async ({ create }) => {
        let sequence = 1;
        const runtime = create({ now: () => 1_000, sleep: sleepWithAbort, idFactory: (prefix) => `${prefix}-${sequence++}` });
        const stats = await runtime.execute({ kind: 'stats' });
        expect(stats.ok).toBe(true);
        expect(stats.value).not.toHaveProperty('rallar.alm');
        expect(stats.value).not.toHaveProperty('rallar.congestion');
    });

    it.each(['complete', 'cancel'] as const)('paces and cancels a loop using real default sleep: %s', async (settlement) => {
        vi.useFakeTimers();
        vi.setSystemTime(1_000);
        try {
            const runtime = createDefaultRallarBlackBoxTestRuntime();
            const pending = runtime.execute({ kind: 'loop', count: 2, intervalMs: 10, commands: [{ kind: 'health' }] });
            try {
                await vi.advanceTimersByTimeAsync(0);
                expect(runtime.state().commandHistory.filter((result) => result.kind === 'health')).toHaveLength(1);
                expect(vi.getTimerCount()).toBe(1);
                await vi.advanceTimersByTimeAsync(9);
                expect(runtime.state().commandHistory.filter((result) => result.kind === 'health')).toHaveLength(1);
                if (settlement === 'cancel') {
                    await runtime.execute({ kind: 'recipe.cancel' });
                    expect((await pending).status).toBe('cancelled');
                }
                else {
                    await vi.advanceTimersByTimeAsync(1);
                    expect(await pending).toMatchObject({ ok: true, value: { iterations: 2, passed: 2 } });
                }
                expect(vi.getTimerCount()).toBe(0);
            }
            finally {
                await runtime.execute({ kind: 'recipe.cancel' });
                await pending;
            }
        }
        finally {
            vi.useRealTimers();
        }
    });

    it('preserves nonpositive and pre-aborted sleep outcomes', async () => {
        const reason = new Error('owned-abort');
        const signal = AbortSignal.abort(reason);
        await expect(sleepWithAbort(0, signal)).resolves.toBeUndefined();
        await expect(sleepWithAbort(-1, signal)).resolves.toBeUndefined();
        await expect(sleepWithAbort(1, signal)).rejects.toBe(reason);
    });
});

describe('black-box HTTP response evidence', () => {
    it('retains only allow-listed response headers with lowercase names', () => {
        const headers = new Headers({
            'Cache-Control': 'no-store',
            'Rallar-State-Source': 'durable',
            'Rallar-State-Revision': '8',
            Authorization: 'Bearer secret',
            'Set-Cookie': 'session=secret'
        });

        expect(normalizeBlackBoxResponseHeaders(headers)).toEqual({
            'cache-control': 'no-store',
            'rallar-state-revision': '8',
            'rallar-state-source': 'durable'
        });
    });
});

describe('rallar-bb runtime core', () => {
    it('redacts sensitive keys and configured secret values', () => {
        const redacted = redactRallarBlackBoxValue(
            {
                username: 'alice',
                password: 'secret',
                accessToken: 'access-token-123',
                ticket: 'ticket-123',
                headers: {
                    authorization: 'Bearer token-123',
                    traceId: 'trace-1'
                },
                nested: {
                    message: 'this includes deploy-secret'
                }
            },
            {
                secretValues: ['deploy-secret']
            }
        );

        expect(redacted).toEqual({
            username: 'alice',
            password: '<redacted>',
            accessToken: '<redacted>',
            ticket: '<redacted>',
            headers: {
                authorization: '<redacted>',
                traceId: 'trace-1'
            },
            nested: {
                message: '<redacted>'
            }
        });
    });

    it('can redact session identifiers when configured for exported reports', () => {
        expect(redactRallarBlackBoxValue(
            {
                sessionId: 'session-1',
                clientId: 'client-1',
                nested: {
                    sessionId: 'session-2'
                }
            },
            {
                keys: ['sessionId', 'clientId']
            }
        )).toEqual({
            sessionId: '<redacted>',
            clientId: '<redacted>',
            nested: {
                sessionId: '<redacted>'
            }
        });
    });

    it('walks lists, replaces any value under a secret key and copies other objects by their own fields', () => {
        const failure = Object.assign(new Error('upload failed'), { code: 'E_UPLOAD', token: 'token-123' });

        expect(redactRallarBlackBoxValue(
            {
                entries: [{ password: 42 }, 'plain', 'has deploy-secret', 7, null],
                failure,
                attempts: 3,
                retried: true
            },
            {
                secretValues: ['deploy-secret']
            }
        )).toEqual({
            entries: [{ password: '<redacted>' }, 'plain', '<redacted>', 7, null],
            failure: { code: 'E_UPLOAD', token: '<redacted>' },
            attempts: 3,
            retried: true
        });
    });

    it('configures the runtime and exposes UI selectors with redacted config', async () => {
        const runtime = createDeterministicRuntime();

        const result = await runtime.execute({
            kind: 'configure',
            commandId: 'configure-1',
            config: {
                runId: 'run-1',
                agentId: 'agent-1',
                apiBaseUrl: 'https://api.example.test',
                actor: 'alice',
                roomId: 'room-1',
                transport: 'realtime',
                rallar: {
                    username: 'alice',
                    password: 'secret'
                }
            }
        });

        const state = runtime.state();
        expect(result.status).toBe('ok');
        expect(state.status).toBe('configured');
        expect(getRallarBlackBoxCurrentConfig(state)).toEqual({
            runId: 'run-1',
            agentId: 'agent-1',
            apiBaseUrl: 'https://api.example.test',
            actor: 'alice',
            roomId: 'room-1',
            transport: 'realtime',
            rallar: {
                username: 'alice',
                password: '<redacted>'
            }
        });
        expect(getRallarBlackBoxActiveCommand(state)).toBeUndefined();
        expect(toRallarBlackBoxDiagnostics(state).some((event) => event.topic === 'rallar.bb.configured')).toBe(true);
    });

    it('passes raw config to command executors while keeping runtime state redacted', async () => {
        let capturedPassword: string | undefined;
        const runtime = createDefaultRallarBlackBoxTestRuntime({
            commandExecutor: (_command, context) => {
                const password = context.config()?.rallar?.password;
                capturedPassword = typeof password === 'string' ? password : undefined;
                return {
                    status: 'ok',
                    value: {
                        password: capturedPassword
                    },
                    nextStatus: context.state().status
                };
            }
        });

        await runtime.execute({
            kind: 'configure',
            commandId: 'configure-raw-executor-config',
            config: {
                rallar: {
                    username: 'alice',
                    password: 'secret'
                }
            }
        });
        const result = await runtime.execute({
            kind: 'health',
            commandId: 'health-raw-executor-config'
        });

        expect(capturedPassword).toBe('secret');
        expect(result.value).toEqual({
            password: '<redacted>'
        });
        expect(getRallarBlackBoxCurrentConfig(runtime.state())?.rallar).toEqual({
            username: 'alice',
            password: '<redacted>'
        });
    });

    it('uses configured redaction rules for later runtime events', async () => {
        const runtime = createDeterministicRuntime();

        await runtime.execute({
            kind: 'configure',
            commandId: 'configure-redaction',
            config: {
                redaction: {
                    secretValues: ['message-secret']
                }
            }
        });
        await runtime.execute({
            kind: 'rtc.send',
            commandId: 'send-secret',
            send: {
                data: {
                    text: 'contains message-secret'
                }
            }
        });

        const sendDiagnostic = toRallarBlackBoxDiagnostics(runtime.state())
            .find((event) => event.topic === 'rallar.bb.fake.rtc.send');

        expect(sendDiagnostic?.payload).toMatchObject({
            diagnosticSchemaVersion: 1,
            diagnosticTypeId: 'rallar.bb.fake.rtc.send',
            topic: 'rallar.bb.fake.rtc.send',
            severity: 'info',
            message: 'rallar.bb.fake.rtc.send',
            command: {
                kind: 'rtc.send',
                commandId: 'send-secret',
                send: {
                    data: {
                        text: '<redacted>'
                    }
                }
            }
        });
    });

    it('loads and runs a recipe through the fake runtime', async () => {
        const runtime = createDeterministicRuntime();
        const recipe: RallarBlackBoxTestRecipe = {
            schemaVersion: 1,
            recipeId: 'recipe-1',
            commands: [
                {
                    kind: 'configure',
                    commandId: 'configure-1',
                    config: {
                        runId: 'run-1',
                        agentId: 'agent-1',
                        actor: 'alice'
                    }
                },
                {
                    kind: 'rtc.connect',
                    commandId: 'connect-1',
                    connection: 'aliceRtc',
                    actor: 'alice',
                    roomId: 'room-1',
                    transport: 'realtime'
                },
                {
                    kind: 'stats',
                    commandId: 'stats-1'
                }
            ]
        };

        const loadResult = await runtime.execute({
            kind: 'recipe.load',
            commandId: 'load-1',
            recipe
        });
        const runResult = await runtime.execute({
            kind: 'recipe.run',
            commandId: 'run-1'
        });

        const state = runtime.state();
        expect(loadResult.ok).toBe(true);
        expect(runResult.ok).toBe(true);
        expect(state.status).toBe('completed');
        expect(getRallarBlackBoxCommandHistory(state).map((result) => result.commandId))
            .toEqual(['load-1', 'configure-1', 'connect-1', 'stats-1', 'run-1']);
        expect(getRallarBlackBoxLatestStats(state)?.counters.commands).toBe(3);
        expect(getRallarBlackBoxFailures(state)).toEqual([]);
    });

    it('records validation failures for invalid recipes', async () => {
        const runtime = createDeterministicRuntime();

        const result = await runtime.execute({
            kind: 'recipe.load',
            commandId: 'load-invalid',
            recipe: {
                schemaVersion: 1,
                recipeId: 'invalid',
                commands: []
            }
        });

        const state = runtime.state();
        expect(result.ok).toBe(false);
        expect(result.status).toBe('failed');
        expect(state.status).toBe('failed');
        expect(getRallarBlackBoxFirstFailure(state)?.commandId).toBe('load-invalid');
        expect(result.error?.message).toBe('Recipe requires at least one command.');
    });

    it('replays cached command results by commandId without duplicating history', async () => {
        const runtime = createDeterministicRuntime();
        const command: RallarBlackBoxTestCommand = {
            kind: 'health',
            commandId: 'health-1'
        };

        const first = await runtime.execute(command);
        const second = await runtime.execute(command);

        expect(first.ok).toBe(true);
        expect(second.ok).toBe(true);
        expect(second.replayed).toBe(true);
        expect(second.value).toEqual(first.value);
        expect(getRallarBlackBoxCommandHistory(runtime.state()).map((result) => result.commandId))
            .toEqual(['health-1']);
    });

    it('re-executes recipe children with the same IDs across separate recipe runs', async () => {
        let sendCount = 0;
        const runtime = createDefaultRallarBlackBoxTestRuntime({
            commandExecutor: (command, context) => {
                if (command.kind !== 'rtc.send') {
                    return undefined;
                }

                sendCount += 1;
                return sendCount === 1
                    ? {
                        status: 'failed',
                        error: {
                            code: 'SEND_FAILED_ONCE',
                            message: 'Synthetic first-run failure.'
                        },
                        nextStatus: 'failed'
                    }
                    : {
                        status: 'ok',
                        value: {
                            sendCount
                        },
                        nextStatus: context.state().status
                    };
            }
        });
        const recipe: RallarBlackBoxTestRecipe = {
            schemaVersion: 1,
            recipeId: 'repeatable-recipe',
            commands: [
                {
                    kind: 'rtc.send',
                    commandId: 'shared-send-id',
                    send: {
                        text: 'same command id'
                    }
                }
            ]
        };

        const first = await runtime.execute({
            kind: 'recipe.run',
            commandId: 'run-repeatable-1',
            recipe
        });
        const second = await runtime.execute({
            kind: 'recipe.run',
            commandId: 'run-repeatable-2',
            recipe
        });

        expect(first.status).toBe('failed');
        expect(second.status).toBe('ok');
        expect(sendCount).toBe(2);
        expect(getRallarBlackBoxCommandHistory(runtime.state()).map((result) => result.commandId)).toEqual([
            'shared-send-id',
            'run-repeatable-1',
            'shared-send-id',
            'run-repeatable-2'
        ]);
    });

    it('keeps commands and results JSON serializable', async () => {
        const runtime = createDeterministicRuntime();
        const command: RallarBlackBoxTestCommand = {
            kind: 'configure',
            commandId: 'configure-json',
            config: {
                runId: 'run-json',
                agentId: 'agent-json'
            }
        };

        const parsedCommand: RallarBlackBoxTestJsonValue = JSON.parse(JSON.stringify(command));
        expect(validateRallarBlackBoxTestCommand(parsedCommand)).toEqual({ ok: true });
        const result = await runtime.execute(parsedCommand as RallarBlackBoxTestCommand);
        const parsedResult = JSON.parse(JSON.stringify(result));

        expect(parsedResult).toEqual(result);
        expect(parsedResult.commandId).toBe('configure-json');
    });
});
