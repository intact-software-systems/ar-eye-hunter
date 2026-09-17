import { describe, expect, it } from 'vitest';
import { normalizeBlackBoxResponseHeaders } from '../../shared-test/black-box-runner/http/normalize-black-box-response-headers.ts';
import {
    createRallarBlackBoxTestRuntime,
    redactRallarBlackBoxValue,
    selectRallarBlackBoxActiveCommand,
    selectRallarBlackBoxCommandHistory,
    selectRallarBlackBoxCurrentConfig,
    selectRallarBlackBoxDiagnostics,
    selectRallarBlackBoxFailures,
    selectRallarBlackBoxFirstFailure,
    selectRallarBlackBoxLatestStats,
    type RallarBlackBoxTestCommand,
    type RallarBlackBoxTestRecipe
} from '../../shared-test/rallar-bb-test/mod.ts';
import { createDeterministicRuntime } from './rallar-bb-runtime/create-deterministic-runtime.ts';

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
        expect(selectRallarBlackBoxCurrentConfig(state)).toEqual({
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
        expect(selectRallarBlackBoxActiveCommand(state)).toBeUndefined();
        expect(selectRallarBlackBoxDiagnostics(state).some((event) => event.topic === 'rallar.bb.configured')).toBe(true);
    });

    it('passes raw config to command executors while keeping runtime state redacted', async () => {
        let capturedPassword: unknown;
        const runtime = createRallarBlackBoxTestRuntime({
            commandExecutor: (_command, context) => {
                const rallarConfig = context.config()?.rallar as { password?: unknown; } | undefined;
                capturedPassword = rallarConfig?.password;
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
        expect(selectRallarBlackBoxCurrentConfig(runtime.state())?.rallar).toEqual({
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

        const sendDiagnostic = selectRallarBlackBoxDiagnostics(runtime.state())
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
        expect(selectRallarBlackBoxCommandHistory(state).map((result) => result.commandId))
            .toEqual(['load-1', 'configure-1', 'connect-1', 'stats-1', 'run-1']);
        expect(selectRallarBlackBoxLatestStats(state)?.counters.commands).toBe(3);
        expect(selectRallarBlackBoxFailures(state)).toEqual([]);
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
        expect(selectRallarBlackBoxFirstFailure(state)?.commandId).toBe('load-invalid');
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
        expect(selectRallarBlackBoxCommandHistory(runtime.state()).map((result) => result.commandId))
            .toEqual(['health-1']);
    });

    it('re-executes recipe children with the same IDs across separate recipe runs', async () => {
        let sendCount = 0;
        const runtime = createRallarBlackBoxTestRuntime({
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
        expect(selectRallarBlackBoxCommandHistory(runtime.state()).map((result) => result.commandId)).toEqual([
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

        const parsedCommand = JSON.parse(JSON.stringify(command)) as RallarBlackBoxTestCommand;
        const result = await runtime.execute(parsedCommand);
        const parsedResult = JSON.parse(JSON.stringify(result));

        expect(parsedResult).toEqual(result);
        expect(parsedResult.commandId).toBe('configure-json');
    });
});
