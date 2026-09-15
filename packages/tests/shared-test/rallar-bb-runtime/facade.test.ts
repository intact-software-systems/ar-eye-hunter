import { describe, expect, it } from 'vitest';
import { executeBlackBox } from '../../../shared-test/black-box-runner/execute-black-box.ts';
import {
    createRallarBlackBoxRtcProvider,
    createRallarBlackBoxTestRuntime,
    selectRallarBlackBoxCommandHistory,
    type RallarBlackBoxTestCommand
} from '../../../shared-test/rallar-bb-test/mod.ts';

describe('rallar-bb runtime facade', () => {
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
