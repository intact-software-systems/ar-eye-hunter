import { describe, expect, it } from 'vitest';

import type { ApiJsonObject } from '@shared/api/api-json-value.ts';

import { executeBlackBox } from '../../shared-test/black-box-runner/execute-black-box.ts';
import { createRallarRemoteBrowserRtcProvider } from '../../shared-test/black-box-runner/rallar-remote-browser-provider.ts';
import { FakeRemoteBrowserControlServer } from './fake-remote-browser-control-server.ts';

const payload = {
    topic: 'presence.ping',
    payload: {
        id: 'ping-1'
    }
};

function toWsSend(interactionExecutionNumber: number, response: ApiJsonObject): ApiJsonObject {
    return {
        WS: {
            request: {
                action: 'send',
                connection: 'controlWs',
                send: payload,
                scenarioExecutionNumber: 1,
                interactionExecutionNumber
            },
            response
        },
        [`sendRemoteWs${interactionExecutionNumber}`]: {}
    };
}

function toRtcSend(interactionExecutionNumber: number, response: ApiJsonObject): ApiJsonObject {
    return {
        RTC: {
            request: {
                action: 'send',
                connection: 'aliceRtc',
                provider: 'rallar-remote-browser',
                actor: 'alice',
                roomId: 'room-1',
                send: payload,
                scenarioExecutionNumber: 1,
                interactionExecutionNumber
            },
            response
        },
        [`sendRemoteRtc${interactionExecutionNumber}`]: {}
    };
}

const wsOpen = {
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
};

const rtcConnect = {
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
};

// The options carry a fetch and a provider instance, so they are wiring, not JSON.
function toWsOptions(server: FakeRemoteBrowserControlServer, runId: string) {
    return {
        rallarRemoteBrowser: {
            controlBaseUrl: 'http://control.example.test',
            runId,
            agentId: 'agent-remote',
            timeoutMs: 500,
            pollIntervalMs: 1,
            fetch: server.fetch
        }
    };
}

function toRtcOptions(server: FakeRemoteBrowserControlServer, runId: string) {
    return {
        rallarRemoteBrowser: {
            controlBaseUrl: 'http://control.example.test',
            runId,
            agentId: 'agent-remote',
            timeoutMs: 500,
            pollIntervalMs: 1
        },
        rtcProviders: {
            'rallar-remote-browser': createRallarRemoteBrowserRtcProvider({
                fetch: server.fetch
            })
        }
    };
}

// Every case sends the same payload twice, so `expect.message` alone would
// match the first frame and report SUCCESS. Only the count dispatch can see
// the second one, which is what makes these discriminating.
describe('remote browser count dispatch', () => {
    it('counts frames on a remote WebSocket wait', async () => {
        const server = new FakeRemoteBrowserControlServer();
        const report = await executeBlackBox(
            [
                wsOpen,
                toWsSend(2, {}),
                toWsSend(3, {}),
                {
                    WS: {
                        request: {
                            action: 'wait',
                            connection: 'controlWs',
                            scenarioExecutionNumber: 1,
                            interactionExecutionNumber: 4
                        },
                        response: {
                            connection: 'controlWs',
                            withinMs: 200,
                            message: payload,
                            count: 1
                        }
                    },
                    countRemoteWs: {}
                }
            ],
            0,
            toWsOptions(server, 'run-remote-ws-count-wait')
        );

        expect(report.resultsByName.countRemoteWs[0].status).toBe('FAILURE');
        expect(report.resultsByName.countRemoteWs[0].actual.matchedCount).toBe(2);
    });

    it('counts frames on a remote WebSocket send', async () => {
        const server = new FakeRemoteBrowserControlServer();
        const report = await executeBlackBox(
            [
                wsOpen,
                toWsSend(2, {}),
                toWsSend(3, {
                    connection: 'controlWs',
                    withinMs: 200,
                    message: payload,
                    count: 2
                })
            ],
            0,
            toWsOptions(server, 'run-remote-ws-count-send')
        );

        expect(report.resultsByName.sendRemoteWs3[0].status).toBe('SUCCESS');
        expect(report.resultsByName.sendRemoteWs3[0].actual.matchedCount).toBe(2);
        expect(report.resultsByName.sendRemoteWs3[0].actual.sendResult.status).toBe('sent');
    });

    it('counts frames on a remote RTC wait', async () => {
        const server = new FakeRemoteBrowserControlServer();
        const report = await executeBlackBox(
            [
                rtcConnect,
                toRtcSend(2, {}),
                toRtcSend(3, {}),
                {
                    RTC: {
                        request: {
                            action: 'wait',
                            connection: 'aliceRtc',
                            provider: 'rallar-remote-browser',
                            actor: 'alice',
                            scenarioExecutionNumber: 1,
                            interactionExecutionNumber: 4
                        },
                        response: {
                            connection: 'aliceRtc',
                            withinMs: 200,
                            message: {
                                topic: 'rallar.remote.fake.message'
                            },
                            count: 1
                        }
                    },
                    countRemoteRtc: {}
                }
            ],
            0,
            toRtcOptions(server, 'run-remote-rtc-count-wait')
        );

        expect(report.resultsByName.countRemoteRtc[0].status).toBe('FAILURE');
        expect(report.resultsByName.countRemoteRtc[0].actual.matchedCount).toBe(2);
    });

    it('counts frames on a remote RTC send', async () => {
        const server = new FakeRemoteBrowserControlServer();
        const report = await executeBlackBox(
            [
                rtcConnect,
                toRtcSend(2, {}),
                toRtcSend(3, {
                    connection: 'aliceRtc',
                    withinMs: 200,
                    message: {
                        topic: 'rallar.remote.fake.message'
                    },
                    count: 2
                })
            ],
            0,
            toRtcOptions(server, 'run-remote-rtc-count-send')
        );

        expect(report.resultsByName.sendRemoteRtc3[0].status).toBe('SUCCESS');
        expect(report.resultsByName.sendRemoteRtc3[0].actual.matchedCount).toBe(2);
    });
});
