import * as timers from 'node:timers/promises';
import { describe, expect, it, vi } from 'vitest';
import {
    createDefaultRallarBlackBoxTestRuntime,
    getRallarBlackBoxCommandHistory,
    getRallarBlackBoxLatestStats,
    type RallarBlackBoxTestRtcSendCommand
} from '../../../shared-test/rallar-bb-test/mod.ts';
import { isJsonRecordValue } from '../../../shared-test/rallar-bb-test/schema/json-schema-validation.ts';
import { createDeterministicRuntime } from './create-deterministic-runtime.ts';

describe('rallar-bb runtime composite', () => {
    it('runs parallel groups with bounded concurrency and deterministic parent ordering', async () => {
        let activeCommands = 0;
        let maxActiveCommands = 0;
        const runtime = createDefaultRallarBlackBoxTestRuntime({
            commandExecutor: async (command, context) => {
                if (command.kind !== 'rtc.send') {
                    return undefined;
                }

                const parallel = command.metadata?.parallel;
                const groupId = isJsonRecordValue(parallel) && typeof parallel.groupId === 'string'
                    ? parallel.groupId
                    : 'unknown';
                activeCommands += 1;
                maxActiveCommands = Math.max(maxActiveCommands, activeCommands);
                await timers.setTimeout(groupId === 'left' ? 30 : groupId === 'middle' ? 5 : 10);
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

        expect(result.ok).toBe(true);
        expect(maxActiveCommands).toBe(2);
        expect(result.value).toMatchObject({
            commandId: 'parallel-room-traffic',
            groupCount: 3,
            maxConcurrency: 2,
            passed: 3,
            failed: 0,
            cancelled: false
        });
        expect(result.value).toHaveProperty('groups', [
            expect.objectContaining({ groupId: 'left' }),
            expect.objectContaining({ groupId: 'middle' }),
            expect.objectContaining({ groupId: 'right' })
        ]);
        expect(result.value).toMatchObject({
            groups: [
                { results: [{ commandId: 'parallel-room-traffic:g1:left:c1:send-shared' }] },
                { results: [{ commandId: 'parallel-room-traffic:g2:middle:c1:send-shared' }] },
                { results: [{ commandId: 'parallel-room-traffic:g3:right:c1:send-shared' }] }
            ]
        });
        expect(result.value).toHaveProperty(
            'groups.0.results.0.result.value',
            expect.objectContaining({
                metadata: {
                    parallel: {
                        commandId: 'parallel-room-traffic',
                        groupId: 'left',
                        groupIndex: 0,
                        commandIndex: 0,
                        originalCommandId: 'send-shared'
                    }
                }
            })
        );
        expect(getRallarBlackBoxCommandHistory(runtime.state()).at(-1)?.commandId).toBe('parallel-room-traffic');
    });

    it('runs later parallel groups after failures when failFast is disabled', async () => {
        const executedCommandIds: string[] = [];
        const runtime = createDefaultRallarBlackBoxTestRuntime({
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

        expect(result.status).toBe('failed');
        expect(result.error?.code).toBe('RALLAR_BLACK_BOX_PARALLEL_CHILD_FAILED');
        expect(result.value).toHaveProperty('failed', 1);
        expect(result.value).toHaveProperty('passed', 1);
        expect(result.value).toHaveProperty('groups', [
            expect.objectContaining({ commandCount: 1 }),
            expect.objectContaining({ commandCount: 1 })
        ]);
        expect(executedCommandIds).toEqual([
            'fail-slow-parallel:g1:left:c1:fail-send',
            'fail-slow-parallel:g2:right:c1:ok-send'
        ]);
    });

    it('stops scheduling later parallel groups after failure by default', async () => {
        const executedCommandIds: string[] = [];
        const runtime = createDefaultRallarBlackBoxTestRuntime({
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

        expect(result.status).toBe('failed');
        expect(result.value).toHaveProperty('groups', [
            expect.objectContaining({ commandCount: 1 }),
            expect.objectContaining({ commandCount: 0 })
        ]);
        expect(executedCommandIds).toEqual([
            'fail-fast-parallel:g1:left:c1:fail-send'
        ]);
    });

    it('keeps scheduling later parallel groups when a child reports cancelled without a runtime cancellation', async () => {
        const executedCommandIds: string[] = [];
        const runtime = createDefaultRallarBlackBoxTestRuntime({
            commandExecutor: (command, context) => {
                if (command.kind !== 'rtc.send') {
                    return undefined;
                }

                executedCommandIds.push(command.commandId ?? '');
                return command.commandId?.includes('cancelled-send')
                    ? { status: 'cancelled', nextStatus: 'cancelled' }
                    : { status: 'ok', value: { sent: true }, nextStatus: context.state().status };
            }
        });

        const result = await runtime.execute({
            kind: 'parallel',
            commandId: 'child-cancelled-parallel',
            maxConcurrency: 1,
            groups: [
                {
                    groupId: 'left',
                    commands: [{ kind: 'rtc.send', commandId: 'cancelled-send' }]
                },
                {
                    groupId: 'right',
                    commands: [{ kind: 'rtc.send', commandId: 'right-send' }]
                }
            ]
        });

        // A cancelled child ends its own group; only a failed child stops the other groups.
        expect(result.status).toBe('cancelled');
        expect(result.value).toHaveProperty('groups', [
            expect.objectContaining({ groupId: 'left', commandCount: 1, cancelled: true }),
            expect.objectContaining({ groupId: 'right', commandCount: 1, cancelled: false })
        ]);
        expect(executedCommandIds).toEqual([
            'child-cancelled-parallel:g1:left:c1:cancelled-send',
            'child-cancelled-parallel:g2:right:c1:right-send'
        ]);
    });

    it('continues within parallel groups and reports ok when continueOnFailure is enabled', async () => {
        const executedCommandIds: string[] = [];
        const runtime = createDefaultRallarBlackBoxTestRuntime({
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

        expect(result.status).toBe('ok');
        expect(result.value).toHaveProperty('passed', 2);
        expect(result.value).toHaveProperty('failed', 1);
        expect(result.value).toHaveProperty('groups', [
            expect.objectContaining({ commandCount: 2 }),
            expect.objectContaining({ commandCount: 1 })
        ]);
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

        expect(result.status).toBe('cancelled');
        expect(result.value).toHaveProperty('cancelled', true);
        expect(result.value).toHaveProperty('groups', [
            expect.objectContaining({ groupId: 'left', commandCount: 2, cancelled: true }),
            expect.objectContaining({ groupId: 'right', commandCount: 0, cancelled: true })
        ]);
        expect(getRallarBlackBoxCommandHistory(runtime.state()).map((command) => command.commandId)).toEqual([
            'cancel-parallel:g1:left:c1:before-cancel',
            'cancel-parallel:g1:left:c2:request-cancel',
            'cancel-parallel'
        ]);
    });

    it('stops scheduling parallel groups after the parent timeout is reached', async () => {
        const executedCommandIds: string[] = [];
        const runtime = createDefaultRallarBlackBoxTestRuntime({
            commandExecutor: async (command, context) => {
                if (command.kind !== 'rtc.send') {
                    return undefined;
                }

                executedCommandIds.push(command.commandId ?? '');
                await timers.setTimeout(25);
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

        expect(result.status).toBe('failed');
        expect(result.error?.code).toBe('RALLAR_BLACK_BOX_PARALLEL_TIMEOUT');
        expect(result.value).toHaveProperty('groups', [
            expect.objectContaining({ commandCount: 1 }),
            expect.objectContaining({ commandCount: 0 })
        ]);
        expect(executedCommandIds).toEqual([
            'timeout-parallel:g1:left:c1:slow-send'
        ]);
    });

    it('executes loop child commands with loop placeholders and metadata', async () => {
        const capturedCommands: RallarBlackBoxTestRtcSendCommand[] = [];
        const runtime = createDefaultRallarBlackBoxTestRuntime({
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

        expect(result.ok).toBe(true);
        expect(result.value).toMatchObject({
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
        expect(capturedCommands).toMatchObject([
            { send: { data: { seq: 0, iteration: 1, label: 'frame-0', commandIndex: 0 } } },
            { send: { data: { seq: 1, iteration: 2, label: 'frame-1', commandIndex: 0 } } },
            { send: { data: { seq: 2, iteration: 3, label: 'frame-2', commandIndex: 0 } } }
        ]);
        expect(capturedCommands[0].metadata).toMatchObject({
            loop: {
                commandId: 'position-loop',
                index: 0,
                iteration: 1,
                commandIndex: 0,
                originalCommandId: 'position-send'
            }
        });
        expect(result.value).toMatchObject({
            results: [
                { commandId: 'position-loop:i1:c1:position-send', originalCommandId: 'position-send', commandIndex: 0, iteration: 1, result: { status: 'ok' } },
                { commandId: 'position-loop:i2:c1:position-send', originalCommandId: 'position-send', commandIndex: 0, iteration: 2, result: { status: 'ok' } },
                { commandId: 'position-loop:i3:c1:position-send', originalCommandId: 'position-send', commandIndex: 0, iteration: 3, result: { status: 'ok' } }
            ]
        });
        expect(getRallarBlackBoxCommandHistory(runtime.state()).map((command) => command.commandId)).toEqual([
            'position-loop:i1:c1:position-send',
            'position-loop:i2:c1:position-send',
            'position-loop:i3:c1:position-send',
            'position-loop'
        ]);
    });

    it('stops loop execution on child failure unless continueOnFailure is true', async () => {
        let sendCount = 0;
        const runtime = createDefaultRallarBlackBoxTestRuntime({
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

        expect(result.status).toBe('failed');
        expect(result.error?.code).toBe('RALLAR_BLACK_BOX_LOOP_CHILD_FAILED');
        expect(result.value).toHaveProperty('childResultCount', 2);
        expect(result.value).toHaveProperty('passed', 1);
        expect(result.value).toHaveProperty('failed', 1);
        expect(sendCount).toBe(2);
    });

    it('continues loop execution after child failure when continueOnFailure is enabled', async () => {
        let sendCount = 0;
        const runtime = createDefaultRallarBlackBoxTestRuntime({
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

        expect(result.status).toBe('ok');
        expect(result.value).toHaveProperty('childResultCount', 3);
        expect(result.value).toHaveProperty('passed', 2);
        expect(result.value).toHaveProperty('failed', 1);
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

        expect(result.status).toBe('cancelled');
        expect(result.value).toHaveProperty('cancelled', true);
        expect(result.value).toHaveProperty('childResultCount', 2);
        expect(getRallarBlackBoxCommandHistory(runtime.state()).map((command) => command.commandId)).toEqual([
            'cancel-loop:i1:c1:before-cancel',
            'cancel-loop:i1:c2:request-cancel',
            'cancel-loop'
        ]);
    });

    it('waits the configured interval between loop iterations', async () => {
        const sendCallEpochMs: number[] = [];
        const runtime = createDefaultRallarBlackBoxTestRuntime({
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
        const runtime = createDefaultRallarBlackBoxTestRuntime({
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
        const statsResult = await runtime.execute({ kind: 'stats', commandId: 'paced-stats' });
        const stats = getRallarBlackBoxLatestStats(runtime.state());
        expect(statsResult.value).toEqual(stats);

        expect(result.ok).toBe(true);
        expect(result.value).toHaveProperty(
            'pacing',
            expect.objectContaining({
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
            })
        );
        expect(result.value).toMatchObject({ pacing: { iterations: [{ startDriftMs: 0 }, { startDriftMs: 5 }, { startDriftMs: 20 }] } });
        expect(result.value).toHaveProperty(
            'sends',
            expect.objectContaining({
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
            })
        );
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
        const runtime = createDefaultRallarBlackBoxTestRuntime({
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

        expect(result.status).toBe('failed');
        expect(result.error?.code).toBe('RALLAR_BLACK_BOX_LOOP_THRESHOLD_FAILED');
        expect(result.value).toHaveProperty('failed', 0);
        expect(result.value).toMatchObject({ thresholdFailures: [{ category: 'pacing' }, { category: 'backpressure' }] });
        expect(result.value).toHaveProperty('sends.backpressureCount', 2);
    });

    it('stops duration-based loops at the configured duration boundary', async () => {
        let now = 0;
        let sendCount = 0;
        const runtime = createDefaultRallarBlackBoxTestRuntime({
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

        expect(result.ok).toBe(true);
        expect(sendCount).toBe(3);
        expect(result.value).toHaveProperty('iterations', 3);
        expect(result.value).toHaveProperty('childResultCount', 3);
    });

    it('rejects loops that exceed the configured child command count limit', async () => {
        const executedCommandIds: string[] = [];
        const runtime = createDefaultRallarBlackBoxTestRuntime({
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

        expect(result.status).toBe('failed');
        expect(result.error?.code).toBe('RALLAR_BLACK_BOX_LOOP_LIMIT_EXCEEDED');
        expect(result.value).toHaveProperty('childResultCount', 0);
        expect(executedCommandIds).toEqual([]);
    });

    it('wakes loop interval sleeps when cancellation is requested', async () => {
        vi.useFakeTimers();
        try {
            const runtime = createDefaultRallarBlackBoxTestRuntime();
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

            expect(result.status).toBe('cancelled');
            expect(result.value).toHaveProperty('cancelled', true);
            expect(result.value).toHaveProperty('childResultCount', 1);
            const commandIds = getRallarBlackBoxCommandHistory(runtime.state()).map((command) => command.commandId);
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
});
