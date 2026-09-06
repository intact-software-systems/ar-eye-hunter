import { describe, expect, it } from 'vitest';
import { executeBlackBox } from '../../shared-test/black-box-runner/execute-black-box.ts';
import { createRallarRemoteBrowserRtcProvider } from '../../shared-test/black-box-runner/rallar-remote-browser-provider.ts';
import { FakeRemoteBrowserControlServer, toJsonResponse } from './fake-remote-browser-control-server.ts';

describe('rallar remote browser RTC provider', () => {
    it('is registered as a default black-box runner RTC provider', async () => {
        const report = await executeBlackBox([]);

        expect(report.rtcProviderNames).toContain('rallar-remote-browser');
    });

    it('sends runner RTC interactions through the control server and consumes remote events', async () => {
        const server = new FakeRemoteBrowserControlServer();
        const roomRef = {
            applicationId: 'app-1',
            workspaceId: 'workspace-a',
            groupId: 'room-1'
        };
        const payload = {
            topic: 'chat.message',
            payload: {
                text: 'hello remote browser'
            }
        };

        const report = await executeBlackBox(
            [
                {
                    RTC: {
                        request: {
                            action: 'connect',
                            connection: 'aliceRtc',
                            provider: 'rallar-remote-browser',
                            actor: 'alice',
                            roomId: 'room-1',
                            roomRef,
                            readiness: {
                                minReadyPeers: 1,
                                timeoutMs: 10_000,
                                intervalMs: 100
                            },
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
                            provider: 'rallar-remote-browser',
                            actor: 'alice',
                            roomId: 'room-1',
                            roomRef,
                            minSnapshotVersion: 11,
                            send: payload,
                            scenarioExecutionNumber: 1,
                            interactionExecutionNumber: 2
                        },
                        response: {
                            connection: 'aliceRtc',
                            withinMs: 500,
                            message: {
                                kind: 'message',
                                topic: 'rallar.remote.fake.message',
                                data: {
                                    ...payload,
                                    roomRef,
                                    minSnapshotVersion: 11
                                }
                            }
                        }
                    },
                    aliceSendsRemote: {}
                },
                {
                    RTC: {
                        request: {
                            action: 'close',
                            connection: 'aliceRtc',
                            provider: 'rallar-remote-browser',
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
                rallarRemoteBrowser: {
                    controlBaseUrl: 'http://control.example.test',
                    runId: 'run-remote',
                    agentId: 'agent-remote',
                    timeoutMs: 500,
                    pollIntervalMs: 1
                },
                rtcProviders: {
                    'rallar-remote-browser': createRallarRemoteBrowserRtcProvider({
                        fetch: server.fetch
                    })
                }
            }
        );

        expect(report.summary.failure).toBe(0);
        expect(server.commands.map((command) => command.kind)).toEqual([
            'rtc.connect',
            'rtc.send',
            'close'
        ]);
        expect(server.commands[0]).toMatchObject({
            kind: 'rtc.connect',
            roomRef,
            readiness: {
                minReadyPeers: 1,
                timeoutMs: 10_000,
                intervalMs: 100
            },
            applicationId: 'app-1',
            workspaceId: 'workspace-a',
            scope: {
                applicationId: 'app-1',
                workspaceId: 'workspace-a'
            }
        });
        expect(server.commands[1]).toMatchObject({
            kind: 'rtc.send',
            roomRef,
            minSnapshotVersion: 11,
            send: {
                ...payload,
                roomRef,
                minSnapshotVersion: 11
            }
        });
        expect(report.resultsByName.connectAlice[0].status).toBe('SUCCESS');
        expect(report.resultsByName.aliceSendsRemote[0].actual.matchedMessage.data)
            .toMatchObject({
                kind: 'message',
                topic: 'rallar.remote.fake.message',
                data: {
                    ...payload,
                    roomRef,
                    minSnapshotVersion: 11
                }
            });
        expect(report.resultsByName.aliceSendsRemote[0].actual.sendResult.status).toBe('sent');
        expect(typeof report.resultsByName.aliceSendsRemote[0].actual.sendLatencyMs).toBe('number');
        expect(report.rtcDiagnostics.aliceRtc[0]).toMatchObject({
            topic: 'rallar.bb.rtc.connected',
            data: {
                connected: true
            }
        });
        expect(report.resultsByName.closeAlice[0].status).toBe('SUCCESS');
    });

    it('waits for remote RTC diagnostics and health through generic expectations', async () => {
        const server = new FakeRemoteBrowserControlServer();

        const report = await executeBlackBox(
            [
                {
                    RTC: {
                        request: {
                            action: 'connect',
                            connection: 'aliceRtc',
                            provider: 'rallar-remote-browser',
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
                            action: 'wait',
                            connection: 'aliceRtc',
                            provider: 'rallar-remote-browser',
                            actor: 'alice',
                            scenarioExecutionNumber: 1,
                            interactionExecutionNumber: 2
                        },
                        response: {
                            withinMs: 500,
                            diagnostic: {
                                topic: 'rallar.bb.rtc.connected',
                                data: {
                                    connected: true
                                }
                            }
                        }
                    },
                    waitForRemoteDiagnostic: {}
                },
                {
                    RTC: {
                        request: {
                            action: 'wait',
                            connection: 'aliceRtc',
                            provider: 'rallar-remote-browser',
                            actor: 'alice',
                            scenarioExecutionNumber: 1,
                            interactionExecutionNumber: 3
                        },
                        response: {
                            withinMs: 500,
                            health: {
                                rallar: {
                                    connected: true,
                                    laneHealth: {
                                        ready: true
                                    }
                                }
                            }
                        }
                    },
                    waitForRemoteHealth: {}
                }
            ],
            0,
            {
                rallarRemoteBrowser: {
                    controlBaseUrl: 'http://control.example.test',
                    runId: 'run-remote-health',
                    agentId: 'agent-remote',
                    timeoutMs: 500,
                    pollIntervalMs: 1
                },
                rtcProviders: {
                    'rallar-remote-browser': createRallarRemoteBrowserRtcProvider({
                        fetch: server.fetch
                    })
                }
            }
        );

        expect(report.summary.failure).toBe(0);
        expect(report.resultsByName.waitForRemoteDiagnostic[0].actual.matchedDiagnostic.topic)
            .toBe('rallar.bb.rtc.connected');
        expect(report.resultsByName.waitForRemoteHealth[0].actual.matchedHealth)
            .toMatchObject({
                rallar: {
                    connected: true,
                    laneHealth: {
                        ready: true
                    }
                }
            });
        expect(server.commands.map((command) => command.kind)).toContain('health');
    });

    it('reports a clear failure when the control server does not return a command result', async () => {
        const fetchWithoutResults = async (input: RequestInfo | URL, init?: RequestInit) => {
            const url = new URL(String(input));
            if (init?.method === 'POST') {
                return toJsonResponse({
                    accepted: true
                }, 202);
            }
            return toJsonResponse({
                runId: url.pathname.split('/').at(-1),
                results: [],
                events: []
            });
        };

        const report = await executeBlackBox(
            [
                {
                    RTC: {
                        request: {
                            action: 'connect',
                            connection: 'aliceRtc',
                            provider: 'rallar-remote-browser',
                            scenarioExecutionNumber: 1,
                            interactionExecutionNumber: 1
                        },
                        response: {}
                    },
                    connectAlice: {}
                }
            ],
            0,
            {
                rallarRemoteBrowser: {
                    controlBaseUrl: 'http://control.example.test',
                    runId: 'run-remote-timeout',
                    agentId: 'agent-remote',
                    timeoutMs: 20,
                    pollIntervalMs: 1
                },
                rtcProviders: {
                    'rallar-remote-browser': createRallarRemoteBrowserRtcProvider({
                        fetch: fetchWithoutResults
                    })
                }
            }
        );

        expect(report.summary.failure).toBe(1);
        expect(report.resultsByName.connectAlice[0].result).toBe('Remote RTC connect failed');
        expect(report.resultsByName.connectAlice[0].actual.exception).toContain(
            'Timed out waiting for remote command result'
        );
    });

    it('auto-closes remote connections through the control server', async () => {
        const server = new FakeRemoteBrowserControlServer();

        const report = await executeBlackBox(
            [
                {
                    RTC: {
                        request: {
                            action: 'connect',
                            connection: 'aliceRtc',
                            provider: 'rallar-remote-browser',
                            actor: 'alice',
                            scenarioExecutionNumber: 1,
                            interactionExecutionNumber: 1
                        },
                        response: {}
                    },
                    connectAlice: {}
                }
            ],
            0,
            {
                rallarRemoteBrowser: {
                    controlBaseUrl: 'http://control.example.test',
                    runId: 'run-remote-auto-close',
                    agentId: 'agent-remote',
                    timeoutMs: 500,
                    pollIntervalMs: 1
                },
                rtcProviders: {
                    'rallar-remote-browser': createRallarRemoteBrowserRtcProvider({
                        fetch: server.fetch
                    })
                }
            }
        );

        expect(report.summary.failure).toBe(0);
        expect(server.commands.map((command) => command.kind)).toEqual([
            'rtc.connect',
            'close'
        ]);
        expect(report.rtcCloseEvents.aliceRtc[0].autoCloseRequested).toBe(true);
    });

    it('routes remote HTTP interactions through the control server', async () => {
        const server = new FakeRemoteBrowserControlServer();

        const report = await executeBlackBox(
            [
                {
                    HTTP: {
                        request: {
                            provider: 'rallar-remote-browser',
                            path: 'https://api.example.test/widgets',
                            method: 'POST',
                            body: {
                                name: 'remote-widget'
                            },
                            scenarioExecutionNumber: 1,
                            interactionExecutionNumber: 1
                        },
                        response: {
                            statusCode: 201,
                            body: {
                                ok: true,
                                method: 'POST',
                                body: {
                                    name: 'remote-widget'
                                }
                            }
                        }
                    },
                    createRemoteWidget: {}
                }
            ],
            0,
            {
                rallarRemoteBrowser: {
                    controlBaseUrl: 'http://control.example.test',
                    runId: 'run-remote-http',
                    agentId: 'agent-remote',
                    timeoutMs: 500,
                    pollIntervalMs: 1,
                    fetch: server.fetch
                }
            }
        );

        expect(report.summary.failure).toBe(0);
        expect(server.commands.map((command) => command.kind)).toEqual([
            'http.request'
        ]);
        const command = server.commands[0];
        expect(command.kind).toBe('http.request');
        if (command.kind === 'http.request') {
            expect(command.request.path).toBe('https://api.example.test/widgets');
            expect(command.request.body).toEqual({
                name: 'remote-widget'
            });
        }
        expect(report.resultsByName.createRemoteWidget[0].actual.statusCode).toBe(201);
        expect(report.resultsByName.createRemoteWidget[0].actual.commandId).toContain('rallar-remote-browser-http');
        expect(report.resultsByName.createRemoteWidget[0].actual.result).toMatchObject({
            status: 201,
            body: {
                ok: true
            }
        });
    });

    it('blocks remote HTTP destinations outside the configured allowlist', async () => {
        const server = new FakeRemoteBrowserControlServer();

        const report = await executeBlackBox(
            [
                {
                    HTTP: {
                        request: {
                            provider: 'rallar-remote-browser',
                            path: 'https://blocked.example.test/widgets',
                            method: 'GET',
                            scenarioExecutionNumber: 1,
                            interactionExecutionNumber: 1
                        },
                        response: {}
                    },
                    blockedRemoteHttp: {}
                }
            ],
            0,
            {
                rallarRemoteBrowser: {
                    controlBaseUrl: 'http://control.example.test',
                    runId: 'run-remote-http-blocked',
                    agentId: 'agent-remote',
                    timeoutMs: 500,
                    pollIntervalMs: 1,
                    fetch: server.fetch,
                    allowedHosts: ['api.example.test']
                }
            }
        );

        expect(report.summary.failure).toBe(1);
        expect(server.commands).toEqual([]);
        expect(report.resultsByName.blockedRemoteHttp[0].exception).toContain('destination is not allowed');
    });

    it('blocks remote WebSocket sends above the configured payload limit', async () => {
        const server = new FakeRemoteBrowserControlServer();

        const report = await executeBlackBox(
            [
                {
                    WS: {
                        request: {
                            action: 'connect',
                            connection: 'controlWs',
                            provider: 'rallar-remote-browser',
                            path: 'wss://ws.example.test/control',
                            scenarioExecutionNumber: 1,
                            interactionExecutionNumber: 1
                        },
                        response: {}
                    },
                    openLimitedRemoteWs: {}
                },
                {
                    WS: {
                        request: {
                            action: 'send',
                            connection: 'controlWs',
                            send: 'payload-too-large',
                            scenarioExecutionNumber: 1,
                            interactionExecutionNumber: 2
                        },
                        response: {}
                    },
                    sendTooLargeRemoteWs: {}
                }
            ],
            0,
            {
                rallarRemoteBrowser: {
                    controlBaseUrl: 'http://control.example.test',
                    runId: 'run-remote-ws-limited',
                    agentId: 'agent-remote',
                    timeoutMs: 500,
                    pollIntervalMs: 1,
                    fetch: server.fetch,
                    maxPayloadBytes: 4
                }
            }
        );

        expect(report.summary.failure).toBe(1);
        expect(server.commands.map((command) => command.kind)).toContain('ws.open');
        expect(server.commands.map((command) => command.kind)).not.toContain('ws.send');
        expect(report.resultsByName.sendTooLargeRemoteWs[0].result).toBe('Remote WebSocket send failed');
        expect(report.resultsByName.sendTooLargeRemoteWs[0].actual.exception).toContain('payload is too large');
    });

    it('routes remote WebSocket interactions through the control server', async () => {
        const server = new FakeRemoteBrowserControlServer();
        const payload = {
            topic: 'presence.ping',
            payload: {
                id: 'ping-1'
            }
        };

        const report = await executeBlackBox(
            [
                {
                    WS: {
                        request: {
                            action: 'connect',
                            connection: 'controlWs',
                            provider: 'rallar-remote-browser',
                            path: 'wss://ws.example.test/control',
                            scenarioExecutionNumber: 1,
                            interactionExecutionNumber: 1
                        },
                        response: {}
                    },
                    openRemoteWs: {}
                },
                {
                    WS: {
                        request: {
                            action: 'send',
                            connection: 'controlWs',
                            send: payload,
                            output: 'wsEchoTopic',
                            outputPath: 'matchedMessage.data.topic',
                            outputs: {
                                wsPayloadId: 'matchedMessage.data.payload.id'
                            },
                            scenarioExecutionNumber: 1,
                            interactionExecutionNumber: 2
                        },
                        response: {
                            connection: 'controlWs',
                            withinMs: 500,
                            message: payload
                        }
                    },
                    sendRemoteWs: {}
                },
                {
                    WS: {
                        request: {
                            action: 'close',
                            connection: 'controlWs',
                            code: 1000,
                            reason: 'done',
                            scenarioExecutionNumber: 1,
                            interactionExecutionNumber: 3
                        },
                        response: {}
                    },
                    closeRemoteWs: {}
                }
            ],
            0,
            {
                rallarRemoteBrowser: {
                    controlBaseUrl: 'http://control.example.test',
                    runId: 'run-remote-ws',
                    agentId: 'agent-remote',
                    timeoutMs: 500,
                    pollIntervalMs: 1,
                    fetch: server.fetch
                }
            }
        );

        expect(report.summary.failure).toBe(0);
        expect(server.commands.map((command) => command.kind)).toEqual([
            'ws.open',
            'ws.send',
            'ws.close'
        ]);
        expect(report.resultsByName.openRemoteWs[0].status).toBe('SUCCESS');
        expect(report.resultsByName.sendRemoteWs[0].actual.matchedMessage.data).toEqual(payload);
        expect(report.outputs.wsEchoTopic).toBe('presence.ping');
        expect(report.outputs.wsPayloadId).toBe('ping-1');
        expect(report.resultsByName.closeRemoteWs[0].status).toBe('SUCCESS');
        expect(report.wsCloseEvents.controlWs[0].code).toBe(1000);
    });

    it('forwards CRDT wait commands through the control server', async () => {
        const server = new FakeRemoteBrowserControlServer();

        const report = await executeBlackBox(
            [
                {
                    CRDT: {
                        request: {
                            action: 'wait',
                            connection: 'aliceRtc',
                            provider: 'rallar-remote-browser',
                            handle: 'checklist',
                            timeoutMs: 1_000,
                            intervalMs: 50,
                            stableForMs: 100,
                            sync: {
                                reason: 'remote-wait-test',
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
                            ],
                            scenarioExecutionNumber: 1,
                            interactionExecutionNumber: 1
                        },
                        response: {}
                    },
                    waitRemoteCrdt: {}
                }
            ],
            0,
            {
                rallarRemoteBrowser: {
                    controlBaseUrl: 'http://control.example.test',
                    runId: 'run-remote-crdt-wait',
                    agentId: 'agent-remote',
                    timeoutMs: 500,
                    pollIntervalMs: 1,
                    fetch: server.fetch
                },
                rtcProviders: {
                    'rallar-remote-browser': createRallarRemoteBrowserRtcProvider({
                        fetch: server.fetch
                    })
                }
            }
        );

        expect(report.summary.failure).toBe(0);
        expect(server.commands[0]).toMatchObject({
            kind: 'crdt.wait',
            handle: 'checklist',
            intervalMs: 50,
            stableForMs: 100,
            sync: {
                reason: 'remote-wait-test',
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
    });
});
