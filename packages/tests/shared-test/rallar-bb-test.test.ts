import { describe, expect, it, vi } from 'vitest';
import { executeBlackBox } from '../../shared-test/black-box-runner/execute-black-box.ts';
import { normalizeBlackBoxResponseHeaders } from '../../shared-test/black-box-runner/http/normalize-black-box-response-headers.ts';
import {
    createRallarBlackBoxBrowserTestRuntime,
    createRallarBlackBoxRtcProvider,
    createRallarBlackBoxTestRuntime,
    redactRallarBlackBoxValue,
    selectRallarBlackBoxActiveCommand,
    selectRallarBlackBoxCommandHistory,
    selectRallarBlackBoxCurrentConfig,
    selectRallarBlackBoxDiagnostics,
    selectRallarBlackBoxEvents,
    selectRallarBlackBoxFailures,
    selectRallarBlackBoxFirstFailure,
    selectRallarBlackBoxLatestStats,
    selectRallarBlackBoxMessages,
    type RallarBlackBoxTestAssertResultValue,
    type RallarBlackBoxTestCommand,
    type RallarBlackBoxTestLoopResultValue,
    type RallarBlackBoxTestParallelResultValue,
    type RallarBlackBoxTestRecipe,
    type RallarBlackBoxTestRtcStreamResultValue,
    type RallarBlackBoxTestWaitResultValue
} from '../../shared-test/rallar-bb-test/mod.ts';

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

function createDeterministicRuntime() {
    let now = 1_000;
    let sequence = 1;
    return createRallarBlackBoxTestRuntime({
        now: () => now++,
        idFactory: (prefix) => `${prefix}-${sequence++}`
    });
}

function sleepMs(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

describe('rallar-bb-test', () => {
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

        expect(sendDiagnostic?.payload).toEqual({
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

        await sleepMs(10);
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

        await sleepMs(10);
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

    it('runs parallel groups with bounded concurrency and deterministic parent ordering', async () => {
        let activeCommands = 0;
        let maxActiveCommands = 0;
        const completedGroups: string[] = [];
        const runtime = createRallarBlackBoxTestRuntime({
            commandExecutor: async (command, context) => {
                if (command.kind !== 'rtc.send') {
                    return undefined;
                }

                const parallel = command.metadata?.parallel as { groupId?: string; } | undefined;
                const groupId = parallel?.groupId ?? 'unknown';
                activeCommands += 1;
                maxActiveCommands = Math.max(maxActiveCommands, activeCommands);
                await sleepMs(groupId === 'left' ? 30 : groupId === 'middle' ? 5 : 10);
                completedGroups.push(groupId);
                activeCommands -= 1;
                return {
                    status: 'ok',
                    value: {
                        groupId,
                        metadata: command.metadata
                    },
                    nextStatus: context.state().status
                };
            }
        });

        const result = await runtime.execute({
            kind: 'parallel',
            commandId: 'parallel-room-traffic',
            maxConcurrency: 2,
            groups: [
                {
                    groupId: 'left',
                    commands: [{ kind: 'rtc.send', commandId: 'send-shared' }]
                },
                {
                    groupId: 'middle',
                    commands: [{ kind: 'rtc.send', commandId: 'send-shared' }]
                },
                {
                    groupId: 'right',
                    commands: [{ kind: 'rtc.send', commandId: 'send-shared' }]
                }
            ]
        });
        const value = result.value as RallarBlackBoxTestParallelResultValue;

        expect(result.ok).toBe(true);
        expect(maxActiveCommands).toBe(2);
        expect(completedGroups).toEqual(['middle', 'right', 'left']);
        expect(value).toMatchObject({
            commandId: 'parallel-room-traffic',
            groupCount: 3,
            maxConcurrency: 2,
            passed: 3,
            failed: 0,
            cancelled: false
        });
        expect(value.groups.map((group) => group.groupId)).toEqual(['left', 'middle', 'right']);
        expect(value.groups.map((group) => group.results[0]?.commandId)).toEqual([
            'parallel-room-traffic:g1:left:c1:send-shared',
            'parallel-room-traffic:g2:middle:c1:send-shared',
            'parallel-room-traffic:g3:right:c1:send-shared'
        ]);
        expect(value.groups[0].results[0]?.result.value).toMatchObject({
            metadata: {
                parallel: {
                    commandId: 'parallel-room-traffic',
                    groupId: 'left',
                    groupIndex: 0,
                    commandIndex: 0,
                    originalCommandId: 'send-shared'
                }
            }
        });
        expect(selectRallarBlackBoxCommandHistory(runtime.state()).at(-1)?.commandId).toBe('parallel-room-traffic');
    });

    it('runs later parallel groups after failures when failFast is disabled', async () => {
        const executedCommandIds: string[] = [];
        const runtime = createRallarBlackBoxTestRuntime({
            commandExecutor: (command, context) => {
                if (command.kind !== 'rtc.send') {
                    return undefined;
                }

                executedCommandIds.push(command.commandId ?? '');
                if (command.commandId?.includes('fail-send')) {
                    return {
                        status: 'failed',
                        error: {
                            code: 'SEND_FAILED',
                            message: 'Synthetic send failure.'
                        },
                        nextStatus: 'failed'
                    };
                }

                return {
                    status: 'ok',
                    value: {
                        sent: true
                    },
                    nextStatus: context.state().status
                };
            }
        });

        const result = await runtime.execute({
            kind: 'parallel',
            commandId: 'fail-slow-parallel',
            maxConcurrency: 1,
            failFast: false,
            groups: [
                {
                    groupId: 'left',
                    commands: [{ kind: 'rtc.send', commandId: 'fail-send' }]
                },
                {
                    groupId: 'right',
                    commands: [{ kind: 'rtc.send', commandId: 'ok-send' }]
                }
            ]
        });
        const value = result.value as RallarBlackBoxTestParallelResultValue;

        expect(result.status).toBe('failed');
        expect(result.error?.code).toBe('RALLAR_BLACK_BOX_PARALLEL_CHILD_FAILED');
        expect(value.failed).toBe(1);
        expect(value.passed).toBe(1);
        expect(value.groups.map((group) => group.commandCount)).toEqual([1, 1]);
        expect(executedCommandIds).toEqual([
            'fail-slow-parallel:g1:left:c1:fail-send',
            'fail-slow-parallel:g2:right:c1:ok-send'
        ]);
    });

    it('stops scheduling later parallel groups after failure by default', async () => {
        const executedCommandIds: string[] = [];
        const runtime = createRallarBlackBoxTestRuntime({
            commandExecutor: (command, context) => {
                if (command.kind !== 'rtc.send') {
                    return undefined;
                }

                executedCommandIds.push(command.commandId ?? '');
                return command.commandId?.includes('fail-send')
                    ? {
                        status: 'failed',
                        error: {
                            code: 'SEND_FAILED',
                            message: 'Synthetic send failure.'
                        },
                        nextStatus: 'failed'
                    }
                    : {
                        status: 'ok',
                        value: {
                            sent: true
                        },
                        nextStatus: context.state().status
                    };
            }
        });

        const result = await runtime.execute({
            kind: 'parallel',
            commandId: 'fail-fast-parallel',
            maxConcurrency: 1,
            groups: [
                {
                    groupId: 'left',
                    commands: [{ kind: 'rtc.send', commandId: 'fail-send' }]
                },
                {
                    groupId: 'right',
                    commands: [{ kind: 'rtc.send', commandId: 'should-not-run' }]
                }
            ]
        });
        const value = result.value as RallarBlackBoxTestParallelResultValue;

        expect(result.status).toBe('failed');
        expect(value.groups.map((group) => group.commandCount)).toEqual([1, 0]);
        expect(executedCommandIds).toEqual([
            'fail-fast-parallel:g1:left:c1:fail-send'
        ]);
    });

    it('continues within parallel groups and reports ok when continueOnFailure is enabled', async () => {
        const executedCommandIds: string[] = [];
        const runtime = createRallarBlackBoxTestRuntime({
            commandExecutor: (command, context) => {
                if (command.kind !== 'rtc.send') {
                    return undefined;
                }

                executedCommandIds.push(command.commandId ?? '');
                return command.commandId?.includes('fail-send')
                    ? {
                        status: 'failed',
                        error: {
                            code: 'SEND_FAILED',
                            message: 'Synthetic send failure.'
                        },
                        nextStatus: 'failed'
                    }
                    : {
                        status: 'ok',
                        value: {
                            sent: true
                        },
                        nextStatus: context.state().status
                    };
            }
        });

        const result = await runtime.execute({
            kind: 'parallel',
            commandId: 'continue-parallel',
            maxConcurrency: 1,
            continueOnFailure: true,
            groups: [
                {
                    groupId: 'left',
                    commands: [
                        { kind: 'rtc.send', commandId: 'fail-send' },
                        { kind: 'rtc.send', commandId: 'after-failure' }
                    ]
                },
                {
                    groupId: 'right',
                    commands: [{ kind: 'rtc.send', commandId: 'right-send' }]
                }
            ]
        });
        const value = result.value as RallarBlackBoxTestParallelResultValue;

        expect(result.status).toBe('ok');
        expect(value.passed).toBe(2);
        expect(value.failed).toBe(1);
        expect(value.groups.map((group) => group.commandCount)).toEqual([2, 1]);
        expect(executedCommandIds).toEqual([
            'continue-parallel:g1:left:c1:fail-send',
            'continue-parallel:g1:left:c2:after-failure',
            'continue-parallel:g2:right:c1:right-send'
        ]);
    });

    it('stops parallel execution when cancellation is requested by a child command', async () => {
        const runtime = createDeterministicRuntime();

        const result = await runtime.execute({
            kind: 'parallel',
            commandId: 'cancel-parallel',
            maxConcurrency: 1,
            groups: [
                {
                    groupId: 'left',
                    commands: [
                        { kind: 'health', commandId: 'before-cancel' },
                        { kind: 'recipe.cancel', commandId: 'request-cancel', reason: 'operator requested stop' },
                        { kind: 'health', commandId: 'after-cancel' }
                    ]
                },
                {
                    groupId: 'right',
                    commands: [{ kind: 'health', commandId: 'should-not-run' }]
                }
            ]
        });
        const value = result.value as RallarBlackBoxTestParallelResultValue;

        expect(result.status).toBe('cancelled');
        expect(value.cancelled).toBe(true);
        expect(value.groups.map((group) => [group.groupId, group.commandCount, group.cancelled])).toEqual([
            ['left', 2, true],
            ['right', 0, true]
        ]);
        expect(selectRallarBlackBoxCommandHistory(runtime.state()).map((command) => command.commandId)).toEqual([
            'cancel-parallel:g1:left:c1:before-cancel',
            'cancel-parallel:g1:left:c2:request-cancel',
            'cancel-parallel'
        ]);
    });

    it('stops scheduling parallel groups after the parent timeout is reached', async () => {
        const executedCommandIds: string[] = [];
        const runtime = createRallarBlackBoxTestRuntime({
            commandExecutor: async (command, context) => {
                if (command.kind !== 'rtc.send') {
                    return undefined;
                }

                executedCommandIds.push(command.commandId ?? '');
                await sleepMs(25);
                return {
                    status: 'ok',
                    value: {
                        sent: true
                    },
                    nextStatus: context.state().status
                };
            }
        });

        const result = await runtime.execute({
            kind: 'parallel',
            commandId: 'timeout-parallel',
            maxConcurrency: 1,
            timeoutMs: 5,
            groups: [
                {
                    groupId: 'left',
                    commands: [{ kind: 'rtc.send', commandId: 'slow-send' }]
                },
                {
                    groupId: 'right',
                    commands: [{ kind: 'rtc.send', commandId: 'should-not-run' }]
                }
            ]
        });
        const value = result.value as RallarBlackBoxTestParallelResultValue;

        expect(result.status).toBe('failed');
        expect(result.error?.code).toBe('RALLAR_BLACK_BOX_PARALLEL_TIMEOUT');
        expect(value.groups.map((group) => group.commandCount)).toEqual([1, 0]);
        expect(executedCommandIds).toEqual([
            'timeout-parallel:g1:left:c1:slow-send'
        ]);
    });

    it('executes loop child commands with loop placeholders and metadata', async () => {
        const capturedCommands: RallarBlackBoxTestCommand[] = [];
        const runtime = createRallarBlackBoxTestRuntime({
            now: (() => {
                let now = 10_000;
                return () => now += 5;
            })(),
            idFactory: (() => {
                let sequence = 1;
                return (prefix: string) => `${prefix}-${sequence++}`;
            })(),
            commandExecutor: (command, context) => {
                if (command.kind !== 'rtc.send') {
                    return undefined;
                }

                capturedCommands.push(command);
                return {
                    status: 'ok',
                    value: {
                        sent: command.send,
                        metadata: command.metadata
                    },
                    nextStatus: context.state().status
                };
            }
        });

        const result = await runtime.execute({
            kind: 'loop',
            commandId: 'position-loop',
            count: 3,
            commands: [
                {
                    kind: 'rtc.send',
                    commandId: 'position-send',
                    send: {
                        data: {
                            seq: '{loop.index}',
                            iteration: '{loop.iteration}',
                            label: 'frame-{loop.index}',
                            elapsedMs: '{loop.elapsedMs}',
                            commandIndex: '{loop.commandIndex}'
                        }
                    }
                }
            ]
        });

        const value = result.value as RallarBlackBoxTestLoopResultValue;
        const sentPayloads = capturedCommands.map((command) =>
            ((command as Extract<RallarBlackBoxTestCommand, { kind: 'rtc.send'; }>).send as {
                data: Record<string, unknown>;
            }).data
        );

        expect(result.ok).toBe(true);
        expect(value).toMatchObject({
            commandId: 'position-loop',
            iterations: 3,
            childResultCount: 3,
            passed: 3,
            failed: 0,
            cancelled: false
        });
        expect(capturedCommands.map((command) => command.commandId)).toEqual([
            'position-loop:i1:c1:position-send',
            'position-loop:i2:c1:position-send',
            'position-loop:i3:c1:position-send'
        ]);
        expect(sentPayloads.map((payload) => payload.seq)).toEqual([0, 1, 2]);
        expect(sentPayloads.map((payload) => payload.iteration)).toEqual([1, 2, 3]);
        expect(sentPayloads.map((payload) => payload.label)).toEqual(['frame-0', 'frame-1', 'frame-2']);
        expect(sentPayloads.map((payload) => payload.commandIndex)).toEqual([0, 0, 0]);
        expect(capturedCommands[0].metadata).toMatchObject({
            loop: {
                commandId: 'position-loop',
                index: 0,
                iteration: 1,
                commandIndex: 0,
                originalCommandId: 'position-send'
            }
        });
        expect(value.results.map((child) => ({
            commandId: child.commandId,
            originalCommandId: child.originalCommandId,
            commandIndex: child.commandIndex,
            iteration: child.iteration,
            status: child.result.status
        }))).toEqual([
            {
                commandId: 'position-loop:i1:c1:position-send',
                originalCommandId: 'position-send',
                commandIndex: 0,
                iteration: 1,
                status: 'ok'
            },
            {
                commandId: 'position-loop:i2:c1:position-send',
                originalCommandId: 'position-send',
                commandIndex: 0,
                iteration: 2,
                status: 'ok'
            },
            {
                commandId: 'position-loop:i3:c1:position-send',
                originalCommandId: 'position-send',
                commandIndex: 0,
                iteration: 3,
                status: 'ok'
            }
        ]);
        expect(selectRallarBlackBoxCommandHistory(runtime.state()).map((command) => command.commandId)).toEqual([
            'position-loop:i1:c1:position-send',
            'position-loop:i2:c1:position-send',
            'position-loop:i3:c1:position-send',
            'position-loop'
        ]);
    });

    it('stops loop execution on child failure unless continueOnFailure is true', async () => {
        let sendCount = 0;
        const runtime = createRallarBlackBoxTestRuntime({
            commandExecutor: (command, context) => {
                if (command.kind !== 'rtc.send') {
                    return undefined;
                }

                sendCount += 1;
                if (sendCount === 2) {
                    return {
                        status: 'failed',
                        error: {
                            code: 'SEND_FAILED',
                            message: 'Synthetic send failure.'
                        },
                        nextStatus: 'failed'
                    };
                }

                return {
                    status: 'ok',
                    value: {
                        sendCount
                    },
                    nextStatus: context.state().status
                };
            }
        });

        const result = await runtime.execute({
            kind: 'loop',
            commandId: 'fail-fast-loop',
            count: 4,
            commands: [{ kind: 'rtc.send', commandId: 'send-once' }]
        });
        const value = result.value as RallarBlackBoxTestLoopResultValue;

        expect(result.status).toBe('failed');
        expect(result.error?.code).toBe('RALLAR_BLACK_BOX_LOOP_CHILD_FAILED');
        expect(value.childResultCount).toBe(2);
        expect(value.passed).toBe(1);
        expect(value.failed).toBe(1);
        expect(sendCount).toBe(2);
    });

    it('continues loop execution after child failure when continueOnFailure is enabled', async () => {
        let sendCount = 0;
        const runtime = createRallarBlackBoxTestRuntime({
            commandExecutor: (command, context) => {
                if (command.kind !== 'rtc.send') {
                    return undefined;
                }

                sendCount += 1;
                return sendCount === 2
                    ? {
                        status: 'failed',
                        error: {
                            code: 'SEND_FAILED',
                            message: 'Synthetic send failure.'
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

        const result = await runtime.execute({
            kind: 'loop',
            commandId: 'continue-loop',
            count: 3,
            continueOnFailure: true,
            commands: [{ kind: 'rtc.send', commandId: 'send-once' }]
        });
        const value = result.value as RallarBlackBoxTestLoopResultValue;

        expect(result.status).toBe('ok');
        expect(value.childResultCount).toBe(3);
        expect(value.passed).toBe(2);
        expect(value.failed).toBe(1);
        expect(sendCount).toBe(3);
    });

    it('stops loop execution when cancellation is requested by a child command', async () => {
        const runtime = createDeterministicRuntime();

        const result = await runtime.execute({
            kind: 'loop',
            commandId: 'cancel-loop',
            count: 2,
            commands: [
                { kind: 'health', commandId: 'before-cancel' },
                { kind: 'recipe.cancel', commandId: 'request-cancel', reason: 'operator requested stop' },
                { kind: 'health', commandId: 'after-cancel' }
            ]
        });
        const value = result.value as RallarBlackBoxTestLoopResultValue;

        expect(result.status).toBe('cancelled');
        expect(value.cancelled).toBe(true);
        expect(value.childResultCount).toBe(2);
        expect(selectRallarBlackBoxCommandHistory(runtime.state()).map((command) => command.commandId)).toEqual([
            'cancel-loop:i1:c1:before-cancel',
            'cancel-loop:i1:c2:request-cancel',
            'cancel-loop'
        ]);
    });

    it('waits the configured interval between loop iterations', async () => {
        const sendCallEpochMs: number[] = [];
        const runtime = createRallarBlackBoxTestRuntime({
            commandExecutor: (command, context) => {
                if (command.kind !== 'rtc.send') {
                    return undefined;
                }

                sendCallEpochMs.push(Date.now());
                return {
                    status: 'ok',
                    value: {
                        sent: true
                    },
                    nextStatus: context.state().status
                };
            }
        });

        const result = await runtime.execute({
            kind: 'loop',
            commandId: 'timed-loop',
            count: 2,
            intervalMs: 25,
            commands: [{ kind: 'rtc.send', commandId: 'timed-send' }]
        });

        expect(result.ok).toBe(true);
        expect(sendCallEpochMs.length).toBe(2);
        expect(sendCallEpochMs[1] - sendCallEpochMs[0]).toBeGreaterThanOrEqual(20);
    });

    it('records deterministic loop pacing, send, and stats summaries', async () => {
        let now = 1_000;
        let sendCount = 0;
        const runtime = createRallarBlackBoxTestRuntime({
            now: () => now,
            sleep: async (ms) => {
                now += ms;
            },
            commandExecutor: (command, context) => {
                if (command.kind !== 'rtc.send') {
                    return undefined;
                }

                sendCount += 1;
                const durationMs = sendCount === 2 ? 15 : 5;
                now += durationMs;
                return {
                    status: 'ok',
                    value: {
                        sendObservation: {
                            commandId: command.commandId,
                            kind: command.kind,
                            transport: 'realtime',
                            durationMs,
                            ok: true,
                            status: sendCount === 2 ? 'rate-limited' : 'sent',
                            backpressured: sendCount === 2
                        }
                    },
                    nextStatus: context.state().status
                };
            }
        });

        const result = await runtime.execute({
            kind: 'loop',
            commandId: 'paced-loop',
            count: 3,
            intervalMs: 10,
            commands: [{ kind: 'rtc.send', commandId: 'paced-send', transport: 'realtime' }]
        });
        const value = result.value as RallarBlackBoxTestLoopResultValue;
        const statsResult = await runtime.execute({ kind: 'stats', commandId: 'paced-stats' });
        const stats = statsResult.value as ReturnType<typeof selectRallarBlackBoxLatestStats>;

        expect(result.ok).toBe(true);
        expect(value.pacing).toMatchObject({
            requestedIntervalMs: 10,
            requestedRateHz: 100,
            completedIterations: 3,
            targetElapsedMs: 20,
            elapsedMs: 45,
            maxStartDriftMs: 20,
            averageStartDriftMs: 8,
            maxJitterMs: 15,
            averageJitterMs: 10,
            lateIterationCount: 1
        });
        expect(value.pacing?.iterations.map((iteration) => iteration.startDriftMs)).toEqual([0, 5, 20]);
        expect(value.sends).toMatchObject({
            sendCount: 3,
            succeeded: 3,
            failed: 0,
            successRatio: 1,
            backpressureCount: 1,
            duration: {
                minMs: 5,
                maxMs: 15,
                averageMs: 8,
                totalMs: 25
            }
        });
        expect(stats?.load?.latestLoopCommandId).toBe('paced-loop');
        expect(stats?.load?.latestPacing).toMatchObject({
            completedIterations: 3,
            maxStartDriftMs: 20
        });
        expect('iterations' in (stats?.load?.latestPacing ?? {})).toBe(false);
        expect(stats?.load?.latestSends).toMatchObject({
            sendCount: 3,
            backpressureCount: 1
        });
        expect('observations' in (stats?.load?.latestSends ?? {})).toBe(false);
    });

    it('fails loops when configured pacing or backpressure thresholds are missed', async () => {
        let now = 2_000;
        const runtime = createRallarBlackBoxTestRuntime({
            now: () => now,
            sleep: async (ms) => {
                now += ms;
            },
            commandExecutor: (command, context) => {
                if (command.kind !== 'rtc.send') {
                    return undefined;
                }

                now += 15;
                return {
                    status: 'ok',
                    value: {
                        sendObservation: {
                            commandId: command.commandId,
                            kind: command.kind,
                            transport: 'realtime',
                            durationMs: 15,
                            ok: true,
                            status: 'rate-limited',
                            backpressured: true
                        }
                    },
                    nextStatus: context.state().status
                };
            }
        });

        const result = await runtime.execute({
            kind: 'loop',
            commandId: 'threshold-loop',
            count: 2,
            intervalMs: 10,
            thresholds: {
                minAchievedRateHz: 50,
                failOnBackpressure: true
            },
            commands: [{ kind: 'rtc.send', commandId: 'threshold-send', transport: 'realtime' }]
        });
        const value = result.value as RallarBlackBoxTestLoopResultValue;

        expect(result.status).toBe('failed');
        expect(result.error?.code).toBe('RALLAR_BLACK_BOX_LOOP_THRESHOLD_FAILED');
        expect(value.failed).toBe(0);
        expect(value.thresholdFailures?.map((failure) => failure.category)).toEqual([
            'pacing',
            'backpressure'
        ]);
        expect(value.sends?.backpressureCount).toBe(2);
    });

    it('stops duration-based loops at the configured duration boundary', async () => {
        let now = 0;
        let sendCount = 0;
        const runtime = createRallarBlackBoxTestRuntime({
            now: () => now,
            commandExecutor: (command, context) => {
                if (command.kind !== 'rtc.send') {
                    return undefined;
                }

                sendCount += 1;
                now += 10;
                return {
                    status: 'ok',
                    value: {
                        sendCount
                    },
                    nextStatus: context.state().status
                };
            }
        });

        const result = await runtime.execute({
            kind: 'loop',
            commandId: 'duration-loop',
            durationMs: 25,
            commands: [{ kind: 'rtc.send', commandId: 'duration-send' }]
        });
        const value = result.value as RallarBlackBoxTestLoopResultValue;

        expect(result.ok).toBe(true);
        expect(sendCount).toBe(3);
        expect(value.iterations).toBe(3);
        expect(value.childResultCount).toBe(3);
    });

    it('rejects loops that exceed the configured child command count limit', async () => {
        const executedCommandIds: string[] = [];
        const runtime = createRallarBlackBoxTestRuntime({
            commandExecutor: (command, context) => {
                if (command.kind !== 'rtc.send') {
                    return undefined;
                }

                executedCommandIds.push(command.commandId ?? '');
                return {
                    status: 'ok',
                    value: {
                        sent: true
                    },
                    nextStatus: context.state().status
                };
            }
        });

        const result = await runtime.execute({
            kind: 'loop',
            commandId: 'too-large-loop',
            count: 3,
            maxCommands: 5,
            commands: [
                { kind: 'rtc.send', commandId: 'send-a' },
                { kind: 'rtc.send', commandId: 'send-b' }
            ]
        });
        const value = result.value as RallarBlackBoxTestLoopResultValue;

        expect(result.status).toBe('failed');
        expect(result.error?.code).toBe('RALLAR_BLACK_BOX_LOOP_LIMIT_EXCEEDED');
        expect(value.childResultCount).toBe(0);
        expect(executedCommandIds).toEqual([]);
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

    it('wakes loop interval sleeps when cancellation is requested', async () => {
        vi.useFakeTimers();
        try {
            const runtime = createRallarBlackBoxTestRuntime();
            const loop = runtime.execute({
                kind: 'loop',
                commandId: 'cancel-during-interval',
                count: 2,
                intervalMs: 60_000,
                commands: [
                    {
                        kind: 'health',
                        commandId: 'interval-health'
                    }
                ]
            });

            await Promise.resolve();
            await runtime.execute({
                kind: 'recipe.cancel',
                commandId: 'cancel-interval',
                reason: 'operator stopped interval loop'
            });
            await Promise.resolve();

            const result = await loop;
            const value = result.value as RallarBlackBoxTestLoopResultValue;

            expect(result.status).toBe('cancelled');
            expect(value.cancelled).toBe(true);
            expect(value.childResultCount).toBe(1);
            const commandIds = selectRallarBlackBoxCommandHistory(runtime.state()).map((command) => command.commandId);
            expect(commandIds).toEqual(expect.arrayContaining([
                'cancel-during-interval:i1:c1:interval-health',
                'cancel-interval',
                'cancel-during-interval'
            ]));
            expect(commandIds.at(-1)).toBe('cancel-during-interval');
        }
        finally {
            vi.useRealTimers();
        }
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

    it('delegates RTC commands to the browser Rallar runtime adapter', async () => {
        const calls: Array<{ name: string; value?: unknown; }> = [];
        const runtime = createRallarBlackBoxBrowserTestRuntime({
            now: (() => {
                let now = 2_000;
                return () => now++;
            })(),
            idFactory: (() => {
                let sequence = 1;
                return (prefix: string) => `${prefix}-${sequence++}`;
            })(),
            rallarRuntime: {
                connect: async (config) => {
                    calls.push({ name: 'connect', value: config });
                    return {
                        connected: true,
                        sessionId: 'session-1'
                    };
                },
                send: async (input) => {
                    calls.push({ name: 'send', value: input });
                    return {
                        sent: true
                    };
                },
                refreshRoom: async () => undefined,
                close: async () => {
                    calls.push({ name: 'close' });
                    return {
                        closed: true
                    };
                },
                health: async () => {
                    calls.push({ name: 'health' });
                    return {
                        connected: true
                    };
                }
            }
        });

        await runtime.execute({
            kind: 'configure',
            commandId: 'configure-browser',
            config: {
                apiBaseUrl: 'https://api.example.test',
                actor: 'alice',
                roomId: 'room-1',
                transport: 'messages.rtc',
                rallar: {
                    typeId: 'chat.message'
                }
            }
        });
        const connectResult = await runtime.execute({
            kind: 'rtc.connect',
            commandId: 'connect-browser',
            connection: 'aliceRtc'
        });
        const sendResult = await runtime.execute({
            kind: 'rtc.send',
            commandId: 'send-browser',
            connection: 'aliceRtc',
            send: {
                payload: {
                    text: 'hello'
                }
            }
        });
        runtime.receiveRallarBrowserEvent({
            kind: 'message',
            topic: 'rallar.browser.messages.rtc.message',
            connection: 'aliceRtc',
            actor: 'alice',
            transport: 'messages.rtc',
            data: {
                password: 'secret',
                text: 'from browser'
            }
        });
        const healthResult = await runtime.execute({
            kind: 'health',
            commandId: 'health-browser'
        });
        const closeResult = await runtime.execute({
            kind: 'close',
            commandId: 'close-browser'
        });

        expect(connectResult.ok).toBe(true);
        expect(sendResult.ok).toBe(true);
        expect(healthResult.ok).toBe(true);
        expect(closeResult.ok).toBe(true);
        expect(calls.map((call) => call.name)).toEqual([
            'connect',
            'send',
            'health',
            'close'
        ]);
        expect(calls[0].value).toEqual({
            connection: 'aliceRtc',
            actor: 'alice',
            roomId: 'room-1',
            rallar: {
                apiBaseUrl: 'https://api.example.test',
                typeId: 'chat.message',
                transport: 'messages.rtc'
            }
        });
        expect(calls[1].value).toEqual({
            payload: {
                text: 'hello'
            }
        });
        expect(selectRallarBlackBoxMessages(runtime.state())[0].payload).toEqual({
            roomId: undefined,
            laneId: undefined,
            peerId: undefined,
            remotePeerId: undefined,
            senderId: undefined,
            typeId: undefined,
            topicId: undefined,
            contextId: undefined,
            resourceId: undefined,
            data: {
                password: '<redacted>',
                text: 'from browser'
            },
            error: undefined
        });
    });

    it('delegates CRDT commands to the browser Rallar runtime adapter', async () => {
        const calls: Array<{ name: string; value?: unknown; }> = [];
        const crdt = Object.fromEntries(
            ['open', 'apply', 'read', 'sync', 'health', 'wait', 'undo', 'redo', 'close', 'destroy']
                .map((name) => [
                    name,
                    async (input: unknown) => {
                        calls.push({ name, value: input });
                        return {
                            status: name,
                            handle: (input as { handle?: string; }).handle,
                            health: {
                                pendingUpdateCount: 0
                            }
                        };
                    }
                ])
        ) as Record<string, (input: unknown) => Promise<unknown>>;
        const runtime = createRallarBlackBoxBrowserTestRuntime({
            rallarRuntime: {
                connect: async () => ({ connected: true }),
                send: async () => ({ sent: true }),
                refreshRoom: async () => undefined,
                close: async () => ({ closed: true }),
                health: async () => ({ connected: true }),
                crdt: crdt as any
            }
        });

        await runtime.execute({
            kind: 'configure',
            commandId: 'configure-crdt',
            config: {
                apiBaseUrl: 'https://api.example.test',
                actor: 'alice',
                roomId: 'room-1',
                rallar: {
                    applicationId: 'rallar-server',
                    workspaceId: 'default'
                }
            }
        });
        await runtime.execute({
            kind: 'crdt.open',
            commandId: 'open-crdt',
            handle: 'doc',
            name: 'checklist',
            transport: 'ws',
            durableCatchUp: 'http'
        });
        await runtime.execute({
            kind: 'crdt.apply',
            commandId: 'apply-crdt',
            handle: 'doc',
            batch: {
                kind: 'batch',
                operations: [
                    {
                        kind: 'counter.add',
                        path: ['count'],
                        delta: 1
                    }
                ]
            }
        });
        await runtime.execute({ kind: 'crdt.read', commandId: 'read-crdt', handle: 'doc' });
        await runtime.execute({ kind: 'crdt.sync', commandId: 'sync-crdt', handle: 'doc', transport: 'ws' });
        await runtime.execute({ kind: 'crdt.health', commandId: 'health-crdt', handle: 'doc' });
        await runtime.execute({
            kind: 'crdt.wait',
            commandId: 'wait-crdt',
            handle: 'doc',
            timeoutMs: 1_000,
            intervalMs: 50,
            sync: {
                reason: 'unit-test',
                transport: 'ws'
            },
            conditions: [
                {
                    source: 'value',
                    path: 'title',
                    operator: 'equals',
                    expected: 'Ready'
                },
                {
                    source: 'health',
                    path: 'pendingUpdateCount',
                    operator: 'equals',
                    expected: 0
                }
            ]
        });
        await runtime.execute({
            kind: 'crdt.undo',
            commandId: 'undo-crdt',
            handle: 'doc',
            targetOperationGroupId: 'group-1',
            operations: [
                {
                    kind: 'counter.add',
                    path: ['count'],
                    delta: -1
                }
            ]
        });
        await runtime.execute({
            kind: 'crdt.redo',
            commandId: 'redo-crdt',
            handle: 'doc',
            targetOperationGroupId: 'group-1',
            operations: [
                {
                    kind: 'counter.add',
                    path: ['count'],
                    delta: 1
                }
            ]
        });
        await runtime.execute({ kind: 'crdt.close', commandId: 'close-crdt', handle: 'doc' });
        await runtime.execute({ kind: 'crdt.destroy', commandId: 'destroy-crdt', handle: 'doc' });

        expect(calls.map((call) => call.name)).toEqual([
            'open',
            'apply',
            'read',
            'sync',
            'health',
            'wait',
            'undo',
            'redo',
            'close',
            'destroy'
        ]);
        expect(calls[0].value).toMatchObject({
            handle: 'doc',
            name: 'checklist',
            apiBaseUrl: 'https://api.example.test',
            actor: 'alice',
            roomId: 'room-1',
            rallar: {
                applicationId: 'rallar-server',
                workspaceId: 'default'
            }
        });
        expect(selectRallarBlackBoxDiagnostics(runtime.state()).map((event) => event.topic)).toEqual(expect.arrayContaining([
            'rallar.bb.crdt.opened',
            'rallar.bb.crdt.applied',
            'rallar.bb.crdt.read',
            'rallar.bb.crdt.synced',
            'rallar.bb.crdt.health',
            'rallar.bb.crdt.waiting',
            'rallar.bb.crdt.wait_matched',
            'rallar.bb.crdt.undone',
            'rallar.bb.crdt.redone',
            'rallar.bb.crdt.closed',
            'rallar.bb.crdt.destroyed'
        ]));
    });

    it('delegates director commands to the browser Rallar runtime adapter', async () => {
        const calls: Array<{ name: string; value?: unknown; }> = [];
        const director = Object.fromEntries(
            ['appoint', 'resign', 'status', 'relayStart', 'intent', 'syncRequest', 'relayStop']
                .map((name) => [
                    name,
                    async (input: unknown) => {
                        calls.push({ name, value: input });
                        return {
                            status: name,
                            handle: (input as { handle?: string; }).handle,
                            role: name === 'appoint' || name === 'relayStart' ? 'director' : 'client',
                            state: 'fresh'
                        };
                    }
                ])
        ) as Record<string, (input: unknown) => Promise<unknown>>;
        const runtime = createRallarBlackBoxBrowserTestRuntime({
            rallarRuntime: {
                connect: async () => ({ connected: true }),
                send: async () => ({ sent: true }),
                refreshRoom: async () => undefined,
                close: async () => ({ closed: true }),
                health: async () => ({ connected: true }),
                director: director as any
            }
        });

        await runtime.execute({
            kind: 'configure',
            commandId: 'configure-director',
            config: {
                apiBaseUrl: 'https://api.example.test',
                actor: 'alice',
                roomId: 'room-1',
                rallar: {
                    applicationId: 'rallar-server',
                    workspaceId: 'default'
                },
                defaults: {
                    groupId: 'room-1'
                }
            }
        });
        await runtime.execute({
            kind: 'director.appoint',
            commandId: 'appoint-director',
            heartbeatTtlMs: 1_200
        });
        await runtime.execute({
            kind: 'director.status',
            commandId: 'status-director',
            refresh: true
        });
        await runtime.execute({
            kind: 'director.relay.start',
            commandId: 'start-director',
            handle: 'relay-1',
            topicId: 'app.test.director',
            intentTypeId: 'app.test.director.intent',
            outputTypeId: 'app.test.director.output',
            heartbeatIntervalMs: 300,
            snapshotIntervalMs: 500
        });
        await runtime.execute({
            kind: 'director.intent',
            commandId: 'intent-director',
            handle: 'relay-1',
            intent: {
                intentId: 'intent-1'
            }
        });
        await runtime.execute({
            kind: 'director.sync.request',
            commandId: 'sync-director',
            handle: 'relay-1',
            payload: {
                reason: 'unit-test'
            }
        });
        await runtime.execute({
            kind: 'director.relay.stop',
            commandId: 'stop-director',
            handle: 'relay-1'
        });
        await runtime.execute({
            kind: 'director.resign',
            commandId: 'resign-director'
        });

        expect(calls.map((call) => call.name)).toEqual([
            'appoint',
            'status',
            'relayStart',
            'intent',
            'syncRequest',
            'relayStop',
            'resign'
        ]);
        expect(calls[0].value).toMatchObject({
            roomId: 'room-1',
            applicationId: 'rallar-server',
            workspaceId: 'default',
            heartbeatTtlMs: 1_200
        });
        expect(calls[2].value).toMatchObject({
            handle: 'relay-1',
            topicId: 'app.test.director',
            intentTypeId: 'app.test.director.intent',
            outputTypeId: 'app.test.director.output'
        });
        expect(selectRallarBlackBoxDiagnostics(runtime.state()).map((event) => event.topic)).toEqual(expect.arrayContaining([
            'rallar.bb.director.appointed',
            'rallar.bb.director.status',
            'rallar.bb.director.relay_started',
            'rallar.bb.director.intent_sent',
            'rallar.bb.director.sync_requested',
            'rallar.bb.director.relay_stopped',
            'rallar.bb.director.resigned'
        ]));
    });

    it('reports unsupported CRDT browser runtimes clearly', async () => {
        const runtime = createRallarBlackBoxBrowserTestRuntime({
            rallarRuntime: {
                connect: async () => ({ connected: true }),
                send: async () => ({ sent: true }),
                refreshRoom: async () => undefined,
                close: async () => ({ closed: true }),
                health: async () => ({ connected: true })
            }
        });

        const result = await runtime.execute({
            kind: 'crdt.read',
            commandId: 'read-crdt-unsupported',
            handle: 'missing'
        });

        expect(result.ok).toBe(false);
        expect(result.error?.message).toContain('does not support CRDT commands');
        expect(selectRallarBlackBoxDiagnostics(runtime.state()).map((event) => event.topic)).toContain(
            'rallar.bb.crdt.failed'
        );
    });

    it('reports unsupported director browser runtimes clearly', async () => {
        const runtime = createRallarBlackBoxBrowserTestRuntime({
            rallarRuntime: {
                connect: async () => ({ connected: true }),
                send: async () => ({ sent: true }),
                refreshRoom: async () => undefined,
                close: async () => ({ closed: true }),
                health: async () => ({ connected: true })
            }
        });

        const result = await runtime.execute({
            kind: 'director.status',
            commandId: 'director-status-unsupported',
            roomId: 'room-1'
        });

        expect(result.ok).toBe(false);
        expect(result.error?.message).toContain('does not support director commands');
        expect(selectRallarBlackBoxDiagnostics(runtime.state()).map((event) => event.topic)).toContain(
            'rallar.bb.director.failed'
        );
    });

    it('honors local browser command delays before live adapter execution', async () => {
        const sendCallEpochMs: number[] = [];
        const runtime = createRallarBlackBoxBrowserTestRuntime({
            rallarRuntime: {
                connect: async () => ({ connected: true }),
                send: async () => {
                    sendCallEpochMs.push(Date.now());
                    return { sent: true };
                },
                refreshRoom: async () => undefined,
                close: async () => ({ closed: true }),
                health: async () => ({ connected: true })
            }
        });

        const startedAtEpochMs = Date.now();
        const result = await runtime.execute({
            kind: 'rtc.send',
            commandId: 'delayed-send',
            metadata: {
                localDelayMs: 25
            },
            send: {
                data: {
                    text: 'delayed'
                }
            }
        });

        expect(result.ok).toBe(true);
        expect(sendCallEpochMs[0] - startedAtEpochMs).toBeGreaterThanOrEqual(20);
    });

    it('executes rtc.stream sends without sequentially blocking frame scheduling', async () => {
        const sendStarts: number[] = [];
        const runtime = createRallarBlackBoxBrowserTestRuntime({
            rallarRuntime: {
                connect: async () => ({ connected: true }),
                send: async (input) => {
                    sendStarts.push(Date.now());
                    await sleepMs(80);
                    return {
                        status: 'sent',
                        input
                    };
                },
                refreshRoom: async () => undefined,
                close: async () => ({ closed: true }),
                health: async () => ({ connected: true })
            }
        });

        const result = await runtime.execute({
            kind: 'rtc.stream',
            commandId: 'stream-position',
            connection: 'rtc',
            transport: 'realtime',
            count: 5,
            intervalMs: 5,
            maxInFlight: 64,
            drainTimeoutMs: 500,
            send: {
                data: {
                    seq: '{stream.index}',
                    frame: '{stream.iteration}'
                }
            }
        });
        const value = result.value as RallarBlackBoxTestRtcStreamResultValue;
        const topics = selectRallarBlackBoxDiagnostics(runtime.state()).map((event) => event.topic);

        expect(result.ok).toBe(true);
        expect(sendStarts).toHaveLength(5);
        expect(Math.max(...sendStarts) - Math.min(...sendStarts)).toBeLessThan(200);
        expect(value).toMatchObject({
            commandId: 'stream-position',
            plannedFrames: 5,
            scheduledFrames: 5,
            attemptedFrames: 5,
            completedFrames: 5,
            failedFrames: 0,
            droppedFrames: 0
        });
        expect(value.duration.p95Ms).toBeGreaterThanOrEqual(70);
        expect(topics).toEqual(expect.arrayContaining([
            'rallar.bb.rtc.stream_started',
            'rallar.bb.rtc.stream_completed'
        ]));
    });

    it('fails rtc.stream when max in-flight saturation violates thresholds', async () => {
        const runtime = createRallarBlackBoxBrowserTestRuntime({
            rallarRuntime: {
                connect: async () => ({ connected: true }),
                send: async () => {
                    await sleepMs(60);
                    return {
                        status: 'sent'
                    };
                },
                refreshRoom: async () => undefined,
                close: async () => ({ closed: true }),
                health: async () => ({ connected: true })
            }
        });

        const result = await runtime.execute({
            kind: 'rtc.stream',
            commandId: 'stream-saturated',
            count: 5,
            intervalMs: 1,
            maxInFlight: 1,
            drainTimeoutMs: 500,
            send: {
                data: {
                    seq: '{stream.index}'
                }
            },
            thresholds: {
                maxDroppedFrames: 0
            }
        });
        const value = result.value as RallarBlackBoxTestRtcStreamResultValue;
        const diagnostic = selectRallarBlackBoxDiagnostics(runtime.state())
            .find((event) => event.topic === 'rallar.bb.rtc.stream_failed');

        expect(result.ok).toBe(false);
        expect(result.error?.code).toBe('RALLAR_BLACK_BOX_RTC_STREAM_THRESHOLD_FAILED');
        expect(value.droppedFrames).toBeGreaterThan(0);
        expect(result.error?.details).toMatchObject({
            value: {
                commandId: 'stream-saturated',
                plannedFrames: 5,
                droppedFrames: value.droppedFrames
            }
        });
        expect(value.thresholdFailures.map((failure) => failure.name)).toContain('maxDroppedFrames');
        expect(diagnostic?.payload).toMatchObject({
            diagnosticTypeId: 'rallar.bb.rtc.stream_failed',
            severity: 'error',
            commandId: 'stream-saturated'
        });
    });

    it('samples rtc.stream raw observations without changing aggregate counts', async () => {
        const runtime = createRallarBlackBoxBrowserTestRuntime({
            rallarRuntime: {
                connect: async () => ({ connected: true }),
                send: async () => ({ status: 'sent' }),
                refreshRoom: async () => undefined,
                close: async () => ({ closed: true }),
                health: async () => ({ connected: true })
            }
        });

        const result = await runtime.execute({
            kind: 'rtc.stream',
            commandId: 'stream-sampled',
            count: 6,
            intervalMs: 1,
            sampleEvery: 3,
            send: {
                data: {
                    seq: '{stream.index}'
                }
            }
        });
        const value = result.value as RallarBlackBoxTestRtcStreamResultValue;

        expect(result.ok).toBe(true);
        expect(value).toMatchObject({
            plannedFrames: 6,
            scheduledFrames: 6,
            attemptedFrames: 6,
            completedFrames: 6,
            failedFrames: 0,
            droppedFrames: 0
        });
        expect(value.observations.map((observation) => observation.index)).toEqual([0, 2, 5]);
    });

    it('executes browser-native HTTP requests through the adapter', async () => {
        const fetchCalls: unknown[] = [];
        const runtime = createRallarBlackBoxBrowserTestRuntime({
            fetch: (async (input, init) => {
                fetchCalls.push({ input, init });
                return new Response(
                    JSON.stringify({
                        received: true,
                        token: 'response-token'
                    }),
                    {
                        status: 201,
                        statusText: 'Created',
                        headers: {
                            authorization: 'Bearer response-token',
                            'content-type': 'application/json'
                        }
                    }
                );
            }) as typeof fetch
        });

        await runtime.execute({
            kind: 'configure',
            commandId: 'configure-http',
            config: {
                apiBaseUrl: 'https://api.example.test/root/'
            }
        });
        const result = await runtime.execute({
            kind: 'http.request',
            commandId: 'http-1',
            request: {
                path: 'v1/items',
                method: 'POST',
                headers: {
                    authorization: 'Bearer request-token',
                    'content-type': 'application/json'
                },
                body: {
                    name: 'item-1'
                }
            },
            response: {
                body: 'json'
            }
        });

        expect(fetchCalls).toEqual([
            {
                input: 'https://api.example.test/root/v1/items',
                init: {
                    method: 'POST',
                    headers: {
                        authorization: 'Bearer request-token',
                        'content-type': 'application/json'
                    },
                    body: '{"name":"item-1"}',
                    credentials: undefined,
                    mode: undefined,
                    signal: expect.any(AbortSignal)
                }
            }
        ]);
        expect(result.ok).toBe(true);
        expect(result.value).toEqual({
            url: 'https://api.example.test/root/v1/items',
            status: 201,
            statusText: 'Created',
            ok: true,
            headers: {
                authorization: '<redacted>',
                'content-type': 'application/json'
            },
            body: {
                received: true,
                token: '<redacted>'
            }
        });
        expect(selectRallarBlackBoxEvents(runtime.state()).some((event) => event.topic === 'rallar.bb.http.response')).toBe(true);
    });

    it('executes browser-native WebSocket commands through the adapter', async () => {
        class FakeSocket {
            readonly url: string;
            readonly protocol = '';
            readyState = 0;
            bufferedAmount = 0;
            readonly sent: unknown[] = [];
            private readonly listeners = new Map<string, Array<(event: unknown) => void>>();

            constructor(url: string) {
                this.url = url;
                queueMicrotask(() => {
                    this.readyState = 1;
                    this.emit('open', {});
                });
            }

            addEventListener(type: string, listener: (event: unknown) => void): void {
                this.listeners.set(type, [
                    ...(this.listeners.get(type) ?? []),
                    listener
                ]);
            }

            removeEventListener(type: string, listener: (event: unknown) => void): void {
                this.listeners.set(
                    type,
                    (this.listeners.get(type) ?? []).filter((entry) => entry !== listener)
                );
            }

            send(data: unknown): void {
                this.sent.push(data);
                this.bufferedAmount = 42;
                this.emit('message', {
                    data
                });
            }

            close(code?: number, reason?: string): void {
                this.readyState = 3;
                this.emit('close', {
                    code,
                    reason,
                    wasClean: true
                });
            }

            private emit(type: string, event: unknown): void {
                (this.listeners.get(type) ?? []).forEach((listener) => listener(event));
            }
        }

        const sockets: FakeSocket[] = [];
        const runtime = createRallarBlackBoxBrowserTestRuntime({
            webSocketFactory: (url) => {
                const socket = new FakeSocket(url);
                sockets.push(socket);
                return socket;
            }
        });

        const openResult = await runtime.execute({
            kind: 'ws.open',
            commandId: 'ws-open',
            connection: 'control',
            url: 'wss://control.example.test/ws'
        });
        const sendResult = await runtime.execute({
            kind: 'ws.send',
            commandId: 'ws-send',
            connection: 'control',
            data: {
                text: 'hello'
            }
        });
        const closeResult = await runtime.execute({
            kind: 'ws.close',
            commandId: 'ws-close',
            connection: 'control',
            code: 1000,
            reason: 'done'
        });

        expect(openResult.ok).toBe(true);
        expect(sendResult.ok).toBe(true);
        expect(closeResult.ok).toBe(true);
        expect(sendResult.value).toMatchObject({
            sendObservation: {
                kind: 'ws.send',
                transport: 'ws',
                status: 'queued',
                queued: true
            }
        });
        expect(sockets[0].sent).toEqual(['{"text":"hello"}']);
        expect(selectRallarBlackBoxMessages(runtime.state())[0].payload).toEqual({
            data: '{"text":"hello"}'
        });
        expect(selectRallarBlackBoxEvents(runtime.state()).some((event) => event.topic === 'rallar.bb.ws.closed')).toBe(true);
    });

    it('keeps ws.send on an open raw socket in browser Rallar provider mode', async () => {
        class FakeSocket {
            readonly url: string;
            readonly protocol = '';
            readyState = 0;
            bufferedAmount = 0;
            readonly sent: unknown[] = [];
            private readonly listeners = new Map<string, Array<(event: unknown) => void>>();

            constructor(url: string) {
                this.url = url;
                queueMicrotask(() => {
                    this.readyState = 1;
                    this.emit('open', {});
                });
            }

            addEventListener(type: string, listener: (event: unknown) => void): void {
                this.listeners.set(type, [
                    ...(this.listeners.get(type) ?? []),
                    listener
                ]);
            }

            removeEventListener(type: string, listener: (event: unknown) => void): void {
                this.listeners.set(
                    type,
                    (this.listeners.get(type) ?? []).filter((entry) => entry !== listener)
                );
            }

            send(data: unknown): void {
                this.sent.push(data);
                this.emit('message', {
                    data
                });
            }

            close(code?: number, reason?: string): void {
                this.readyState = 3;
                this.emit('close', {
                    code,
                    reason,
                    wasClean: true
                });
            }

            private emit(type: string, event: unknown): void {
                (this.listeners.get(type) ?? []).forEach((listener) => listener(event));
            }
        }

        const sockets: FakeSocket[] = [];
        const runtime = createRallarBlackBoxBrowserTestRuntime({
            webSocketFactory: (url) => {
                const socket = new FakeSocket(url);
                sockets.push(socket);
                return socket;
            },
            rallarRuntime: {
                connect: async () => ({ connected: true }),
                send: async () => ({ sent: true }),
                sendWs: async () => {
                    throw new Error('raw socket should handle ws.send while open');
                },
                refreshRoom: async () => undefined,
                close: async () => ({ closed: true }),
                health: async () => ({ connected: true })
            }
        });

        await runtime.execute({
            kind: 'configure',
            commandId: 'configure-browser-rallar-raw-ws',
            config: {
                control: {
                    providerMode: 'browser-rallar'
                }
            }
        });
        await runtime.execute({
            kind: 'ws.open',
            commandId: 'open-browser-rallar-raw-ws',
            connection: 'control',
            url: 'wss://control.example.test/ws'
        });
        const sendResult = await runtime.execute({
            kind: 'ws.send',
            commandId: 'send-browser-rallar-raw-ws',
            connection: 'control',
            data: {
                groupId: 'room-1',
                topic: 'rallar.black-box.live-three-browser.ws',
                text: 'raw socket payload'
            }
        });

        expect(sendResult.ok).toBe(true);
        expect(sockets[0].sent).toEqual([
            '{"groupId":"room-1","topic":"rallar.black-box.live-three-browser.ws","text":"raw socket payload"}'
        ]);
    });

    it('cleans up browser WS and Rallar resources after a cancelled recipe', async () => {
        class FakeSocket {
            readonly url: string;
            readonly protocol = '';
            readyState = 0;
            closeCount = 0;
            private readonly listeners = new Map<string, Array<(event: unknown) => void>>();

            constructor(url: string) {
                this.url = url;
                queueMicrotask(() => {
                    this.readyState = 1;
                    this.emit('open', {});
                });
            }

            addEventListener(type: string, listener: (event: unknown) => void): void {
                this.listeners.set(type, [
                    ...(this.listeners.get(type) ?? []),
                    listener
                ]);
            }

            removeEventListener(type: string, listener: (event: unknown) => void): void {
                this.listeners.set(
                    type,
                    (this.listeners.get(type) ?? []).filter((entry) => entry !== listener)
                );
            }

            send(_data: unknown): void {
                // Not needed for this cleanup regression.
            }

            close(code?: number, reason?: string): void {
                this.closeCount += 1;
                this.readyState = 3;
                this.emit('close', {
                    code,
                    reason,
                    wasClean: true
                });
            }

            private emit(type: string, event: unknown): void {
                (this.listeners.get(type) ?? []).forEach((listener) => listener(event));
            }
        }

        const sockets: FakeSocket[] = [];
        const rallarCalls: string[] = [];
        const runtime = createRallarBlackBoxBrowserTestRuntime({
            webSocketFactory: (url) => {
                const socket = new FakeSocket(url);
                sockets.push(socket);
                return socket;
            },
            rallarRuntime: {
                connect: async () => {
                    rallarCalls.push('connect');
                    return { connected: true };
                },
                send: async () => ({ sent: true }),
                refreshRoom: async () => undefined,
                close: async () => {
                    rallarCalls.push('close');
                    return { closed: true };
                },
                health: async () => ({ connected: true })
            }
        });

        const result = await runtime.execute({
            kind: 'recipe.run',
            commandId: 'run-cancel-cleanup',
            recipe: {
                recipeId: 'cancel-cleanup',
                commands: [
                    {
                        kind: 'configure',
                        commandId: 'configure-cleanup',
                        config: {
                            actor: 'alice',
                            roomId: 'room-1'
                        }
                    },
                    {
                        kind: 'ws.open',
                        commandId: 'open-cleanup-ws',
                        connection: 'control',
                        url: 'wss://control.example.test/ws'
                    },
                    {
                        kind: 'rtc.connect',
                        commandId: 'connect-cleanup-rtc',
                        connection: 'aliceRtc'
                    },
                    {
                        kind: 'recipe.cancel',
                        commandId: 'cancel-cleanup-recipe',
                        reason: 'cleanup isolation regression'
                    }
                ]
            }
        });
        const health = await runtime.execute({
            kind: 'health',
            commandId: 'health-after-cleanup'
        });

        expect(result.status).toBe('cancelled');
        expect(sockets).toHaveLength(1);
        expect(sockets[0].closeCount).toBe(1);
        expect(rallarCalls).toEqual(['connect', 'close']);
        expect(health.value).toMatchObject({
            webSockets: []
        });
        expect(selectRallarBlackBoxEvents(runtime.state()).some((event) => event.topic === 'rallar.bb.cleanup.resources_closed')).toBe(true);
    });

    it('routes ws.send through browser Rallar signaling when no raw socket is open', async () => {
        const sends: unknown[] = [];
        const runtime = createRallarBlackBoxBrowserTestRuntime({
            rallarRuntime: {
                connect: async () => ({ connected: true }),
                send: async () => ({ sent: true }),
                sendWs: async (input) => {
                    sends.push(input);
                    return {
                        status: 'sent',
                        transport: 'ws'
                    };
                },
                refreshRoom: async () => undefined,
                close: async () => ({ closed: true }),
                health: async () => ({ connected: true })
            }
        });

        await runtime.execute({
            kind: 'configure',
            commandId: 'configure-browser-ws',
            config: {
                apiBaseUrl: 'https://api.example.test',
                actor: 'alice',
                roomId: 'room-1',
                control: {
                    providerMode: 'browser-rallar'
                }
            }
        });
        const sendResult = await runtime.execute({
            kind: 'ws.send',
            commandId: 'ws-send-rallar',
            connection: 'rallarApi',
            data: {
                applicationId: 'app-1',
                workspaceId: 'workspace-a',
                scope: 'room',
                roomId: 'room-1',
                groupId: 'room-1',
                typeId: 'room.black-box.ws.probe',
                topicId: 'room.black-box.ws.probe',
                contextId: 'room-1',
                payload: {
                    text: 'hello over signaling'
                }
            }
        });

        expect(sendResult.ok).toBe(true);
        expect(sends).toEqual([{
            applicationId: 'app-1',
            workspaceId: 'workspace-a',
            scope: 'room',
            roomId: 'room-1',
            groupId: 'room-1',
            typeId: 'room.black-box.ws.probe',
            topicId: 'room.black-box.ws.probe',
            contextId: 'room-1',
            payload: {
                text: 'hello over signaling'
            }
        }]);
        expect(sendResult.value).toMatchObject({
            connection: 'rallarApi',
            via: 'rallar-signaling-websocket'
        });
        expect(selectRallarBlackBoxEvents(runtime.state()).some((event) => event.topic === 'rallar.bb.ws.sent_via_rallar_signaling')).toBe(true);
    });

    it('prefers browser Rallar signaling for app WS envelopes even when a raw socket is open', async () => {
        class FakeSocket {
            readonly url: string;
            readonly protocol = '';
            readyState = 0;
            readonly sent: unknown[] = [];
            private readonly listeners = new Map<string, Array<(event: unknown) => void>>();

            constructor(url: string) {
                this.url = url;
                queueMicrotask(() => {
                    this.readyState = 1;
                    this.emit('open', {});
                });
            }

            addEventListener(type: string, listener: (event: unknown) => void): void {
                this.listeners.set(type, [
                    ...(this.listeners.get(type) ?? []),
                    listener
                ]);
            }

            removeEventListener(type: string, listener: (event: unknown) => void): void {
                this.listeners.set(
                    type,
                    (this.listeners.get(type) ?? []).filter((entry) => entry !== listener)
                );
            }

            send(data: unknown): void {
                this.sent.push(data);
            }

            close(code?: number, reason?: string): void {
                this.readyState = 3;
                this.emit('close', {
                    code,
                    reason,
                    wasClean: true
                });
            }

            private emit(type: string, event: unknown): void {
                (this.listeners.get(type) ?? []).forEach((listener) => listener(event));
            }
        }

        const sockets: FakeSocket[] = [];
        const connects: unknown[] = [];
        const sends: unknown[] = [];
        const runtime = createRallarBlackBoxBrowserTestRuntime({
            webSocketFactory: (url) => {
                const socket = new FakeSocket(url);
                sockets.push(socket);
                return socket;
            },
            rallarRuntime: {
                connect: async (config) => {
                    connects.push(config);
                    return { connected: true };
                },
                send: async () => ({ sent: true }),
                sendWs: async (input) => {
                    if (connects.length === 0) {
                        throw new Error('Black-box Rallar runtime is not connected.');
                    }
                    sends.push(input);
                    return {
                        status: 'sent',
                        transport: 'ws'
                    };
                },
                refreshRoom: async () => undefined,
                close: async () => ({ closed: true }),
                health: async () => ({ connected: true })
            }
        });

        await runtime.execute({
            kind: 'configure',
            commandId: 'configure-browser-ws',
            config: {
                apiBaseUrl: 'https://api.example.test',
                actor: 'alice',
                sessionId: 'alice-session',
                roomId: 'room-1',
                rallar: {
                    applicationId: 'app-1',
                    workspaceId: 'workspace-a',
                    restoreSession: true
                },
                control: {
                    providerMode: 'browser-rallar'
                }
            }
        });
        const openResult = await runtime.execute({
            kind: 'ws.open',
            commandId: 'ws-open-rallar',
            connection: 'rallarApi',
            url: 'wss://control.example.test/ws'
        });
        const sendResult = await runtime.execute({
            kind: 'ws.send',
            commandId: 'ws-send-rallar',
            connection: 'rallarApi',
            data: {
                applicationId: 'app-1',
                workspaceId: 'workspace-a',
                scope: 'room',
                roomId: 'room-1',
                groupId: 'room-1',
                typeId: 'room.manual.message',
                topicId: 'room.manual.message',
                contextId: 'room-1',
                payload: {
                    text: 'hello over app ws'
                }
            }
        });

        expect(openResult.ok).toBe(true);
        expect(sendResult.ok).toBe(true);
        expect(sockets[0].sent).toEqual([]);
        expect(connects).toHaveLength(1);
        expect(connects[0]).toMatchObject({
            connection: 'rallarApi',
            actor: 'alice',
            roomId: 'room-1',
            rallar: {
                apiBaseUrl: 'https://api.example.test',
                applicationId: 'app-1',
                workspaceId: 'workspace-a',
                restoreSession: true,
                transport: 'realtime'
            }
        });
        expect(sends).toEqual([{
            applicationId: 'app-1',
            workspaceId: 'workspace-a',
            scope: 'room',
            roomId: 'room-1',
            groupId: 'room-1',
            typeId: 'room.manual.message',
            topicId: 'room.manual.message',
            contextId: 'room-1',
            payload: {
                text: 'hello over app ws'
            }
        }]);
    });

    it('drives a black-box runner RTC scenario through the facade adapter', async () => {
        const runtime = createRallarBlackBoxTestRuntime({
            commandExecutor: async (command, context) => {
                if (command.kind === 'rtc.connect') {
                    return {
                        status: 'ok',
                        value: {
                            connected: true,
                            connection: command.connection
                        },
                        nextStatus: 'configured'
                    };
                }

                if (command.kind === 'rtc.send') {
                    context.recordEvent({
                        kind: 'message',
                        topic: 'rallar.bb.facade.echo',
                        commandId: command.commandId,
                        connection: command.connection,
                        transport: command.transport,
                        payload: {
                            data: command.send
                        }
                    });
                    return {
                        status: 'ok',
                        value: {
                            sent: command.send
                        },
                        nextStatus: context.state().status
                    };
                }

                if (command.kind === 'close') {
                    context.recordEvent({
                        kind: 'event',
                        topic: 'rallar.bb.facade.closed',
                        commandId: command.commandId,
                        connection: String(command.metadata?.connection),
                        payload: {
                            closed: true
                        }
                    });
                    return {
                        status: 'ok',
                        value: {
                            closed: true
                        },
                        nextStatus: 'idle'
                    };
                }

                return undefined;
            }
        });
        const provider = createRallarBlackBoxRtcProvider(runtime, {
            commandIdPrefix: 'facade'
        });
        const payload = {
            topic: 'chat.message',
            payload: {
                text: 'hello through facade'
            }
        };

        const report = await executeBlackBox(
            [
                {
                    RTC: {
                        request: {
                            action: 'connect',
                            connection: 'aliceRtc',
                            provider: 'rallar-bb',
                            actor: 'alice',
                            roomId: 'room-1',
                            scenarioExecutionNumber: 1,
                            interactionExecutionNumber: 1
                        },
                        response: {}
                    },
                    connectAlice: {}
                },
                {
                    RTC: {
                        request: {
                            action: 'send',
                            connection: 'aliceRtc',
                            provider: 'rallar-bb',
                            actor: 'alice',
                            roomId: 'room-1',
                            send: payload,
                            scenarioExecutionNumber: 1,
                            interactionExecutionNumber: 2
                        },
                        response: {
                            connection: 'aliceRtc',
                            withinMs: 1000,
                            message: payload
                        }
                    },
                    aliceSendsAndReceivesFacadeEcho: {}
                },
                {
                    RTC: {
                        request: {
                            action: 'close',
                            connection: 'aliceRtc',
                            provider: 'rallar-bb',
                            actor: 'alice',
                            roomId: 'room-1',
                            scenarioExecutionNumber: 1,
                            interactionExecutionNumber: 3
                        },
                        response: {}
                    },
                    closeAlice: {}
                }
            ],
            0,
            {
                rtcProviders: {
                    'rallar-bb': provider
                }
            }
        );

        expect(report.summary.failure).toBe(0);
        expect(report.resultsByName.connectAlice[0].status).toBe('SUCCESS');
        expect(report.resultsByName.aliceSendsAndReceivesFacadeEcho[0].status)
            .toBe('SUCCESS');
        expect(report.resultsByName.closeAlice[0].status).toBe('SUCCESS');
        expect(selectRallarBlackBoxCommandHistory(runtime.state()).map((result) => result.kind))
            .toEqual(['rtc.connect', 'rtc.send', 'close']);
    });

    it('passes scoped runner RTC fields through the local facade adapter', async () => {
        const executedCommands: RallarBlackBoxTestCommand[] = [];
        const expectedScopedPayload = {
            topic: 'chat.scoped',
            payload: {
                text: 'hello scoped room'
            },
            applicationId: 'app-1',
            workspaceId: 'workspace-a',
            scope: {
                applicationId: 'app-1',
                workspaceId: 'workspace-a'
            },
            roomRef: {
                applicationId: 'app-1',
                workspaceId: 'workspace-a',
                groupId: 'group-1'
            },
            minSnapshotVersion: 7
        };
        const runtime = createRallarBlackBoxTestRuntime({
            commandExecutor: (command, context) => {
                executedCommands.push(command);
                if (command.kind === 'rtc.connect') {
                    return {
                        status: 'ok',
                        value: {
                            connected: true,
                            command
                        },
                        nextStatus: 'configured'
                    };
                }

                if (command.kind === 'rtc.send') {
                    context.recordEvent({
                        kind: 'message',
                        topic: 'rallar.bb.facade.noise',
                        commandId: command.commandId,
                        connection: 'otherRtc',
                        payload: {
                            data: {
                                topic: 'noise'
                            }
                        }
                    });
                    context.recordEvent({
                        kind: 'message',
                        topic: 'rallar.bb.facade.echo',
                        commandId: command.commandId,
                        connection: command.connection,
                        transport: command.transport,
                        payload: {
                            data: command.send
                        }
                    });
                    return {
                        status: 'ok',
                        value: {
                            sent: command.send
                        },
                        nextStatus: context.state().status
                    };
                }

                return undefined;
            }
        });
        const provider = createRallarBlackBoxRtcProvider(runtime, {
            commandIdPrefix: 'scoped'
        });

        const report = await executeBlackBox(
            [
                {
                    RTC: {
                        request: {
                            action: 'connect',
                            commandId: 'connect-scoped',
                            connection: 'aliceRtc',
                            provider: 'rallar-bb',
                            actor: 'alice',
                            roomId: 'group-1',
                            rallar: {
                                apiBaseUrl: 'https://api.example.test',
                                applicationId: 'app-1',
                                workspaceId: 'workspace-a',
                                transport: 'messages.rtc'
                            },
                            minSnapshotVersion: 7
                        },
                        response: {}
                    },
                    connectScopedAlice: {}
                },
                {
                    RTC: {
                        request: {
                            action: 'send',
                            commandId: 'send-scoped',
                            connection: 'aliceRtc',
                            provider: 'rallar-bb',
                            actor: 'alice',
                            roomId: 'group-1',
                            rallar: {
                                applicationId: 'app-1',
                                workspaceId: 'workspace-a',
                                transport: 'messages.rtc'
                            },
                            minSnapshotVersion: 7,
                            send: {
                                topic: 'chat.scoped',
                                payload: {
                                    text: 'hello scoped room'
                                }
                            }
                        },
                        response: {
                            connection: 'aliceRtc',
                            withinMs: 1000,
                            message: expectedScopedPayload
                        }
                    },
                    scopedAliceSend: {}
                }
            ],
            0,
            {
                rtcProviders: {
                    'rallar-bb': provider
                }
            }
        );

        expect(report.summary.failure).toBe(0);
        expect(report.resultsByName.scopedAliceSend[0].actual.matchedMessage.data)
            .toEqual(expectedScopedPayload);
        expect(executedCommands.find((command) => command.kind === 'rtc.connect'))
            .toMatchObject({
                kind: 'rtc.connect',
                commandId: 'connect-scoped',
                connection: 'aliceRtc',
                actor: 'alice',
                roomId: 'group-1',
                applicationId: 'app-1',
                workspaceId: 'workspace-a',
                scope: {
                    applicationId: 'app-1',
                    workspaceId: 'workspace-a'
                },
                roomRef: {
                    applicationId: 'app-1',
                    workspaceId: 'workspace-a',
                    groupId: 'group-1'
                },
                minSnapshotVersion: 7,
                transport: 'messages.rtc',
                rallar: {
                    apiBaseUrl: 'https://api.example.test',
                    applicationId: 'app-1',
                    workspaceId: 'workspace-a',
                    scope: {
                        applicationId: 'app-1',
                        workspaceId: 'workspace-a'
                    },
                    roomRef: {
                        applicationId: 'app-1',
                        workspaceId: 'workspace-a',
                        groupId: 'group-1'
                    },
                    minSnapshotVersion: 7,
                    transport: 'messages.rtc'
                }
            });
        expect(executedCommands.find((command) => command.kind === 'rtc.send'))
            .toMatchObject({
                kind: 'rtc.send',
                commandId: 'send-scoped',
                connection: 'aliceRtc',
                applicationId: 'app-1',
                workspaceId: 'workspace-a',
                scope: {
                    applicationId: 'app-1',
                    workspaceId: 'workspace-a'
                },
                roomRef: {
                    applicationId: 'app-1',
                    workspaceId: 'workspace-a',
                    groupId: 'group-1'
                },
                minSnapshotVersion: 7,
                transport: 'messages.rtc',
                send: expectedScopedPayload
            });
    });
});
