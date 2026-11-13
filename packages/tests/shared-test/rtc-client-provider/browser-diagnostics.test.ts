import { expect, test } from 'bun:test';
import { executeBlackBox } from '../../../shared-test/black-box-runner/execute-black-box.ts';
import { createRallarBrowserRtcProvider } from '../../../shared-test/black-box-runner/rallar-browser-rtc-provider.ts';

test('createRallarBrowserRtcProvider records page load failure diagnostics', async () => {
    let browserCloseCount = 0;
    let contextCloseCount = 0;

    const page = {
        async exposeFunction(_name: string, _handler: (event: any) => void | Promise<void>) {
            // no-op
        },

        on(_type: string, _handler: (event?: any) => void) {
            // no-op
        },

        async goto(_url: string, _options: any) {
            throw new Error('harness load failed');
        },

        async waitForFunction(_fn: () => boolean, _arg: unknown, _options: any) {
            // no-op
        },

        async evaluate(_fn: (...args: any[]) => unknown, _input?: any) {
            return {
                status: 'connected',
                sessionId: 'alice-rallar-session'
            };
        }
    };

    const provider = createRallarBrowserRtcProvider({
        harnessUrl: 'http://black-box-harness.local/rallar-browser-harness.html',
        dependencies: {
            chromium: {
                launch: async () => ({
                    async newContext() {
                        return {
                            async newPage() {
                                return page;
                            },

                            async close() {
                                contextCloseCount += 1;
                            }
                        };
                    },

                    async close() {
                        browserCloseCount += 1;
                    }
                })
            }
        }
    });

    const report = await executeBlackBox(
        [
            {
                RTC: {
                    request: {
                        action: 'connect',
                        connection: 'aliceRtc',
                        provider: 'rallar-browser',
                        actor: 'alice',
                        roomId: 'room-1',
                        rallar: {
                            apiBaseUrl: 'https://api.example.test',
                            username: 'alice',
                            password: 'secret',
                            transport: 'realtime',
                            laneId: 'realtime'
                        },
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
            rtcProviders: {
                'rallar-browser': provider
            }
        }
    );

    expect(report.summary.failure).toEqual(1);
    expect(report.resultsByName.connectAlice[0].actual.exception).toEqual('harness load failed');
    expect(contextCloseCount).toEqual(1);
    expect(browserCloseCount).toEqual(1);

    const diagnostics = report.rtcMessages.aliceRtc.map((message: any) => message.data);
    const pageLoadFailed = diagnostics
        .find((event: any) => event.topic === 'rallar.browser.provider.page_load_failed');
    const connectFailed = diagnostics
        .find((event: any) => event.topic === 'rallar.browser.provider.connect_failed');

    expect(pageLoadFailed?.data?.harnessUrl).toEqual('http://black-box-harness.local/rallar-browser-harness.html');
    expect(connectFailed?.data?.phase).toEqual('page-load');
});

test('createRallarBrowserRtcProvider records runtime send failure diagnostics', async () => {
    const page = {
        exposed: {} as Record<string, (event: any) => void | Promise<void>>,

        async exposeFunction(name: string, handler: (event: any) => void | Promise<void>) {
            this.exposed[name] = handler;
        },

        on(_type: string, _handler: (event?: any) => void) {
            // no-op
        },

        async goto(_url: string, _options: any) {
            // no-op
        },

        async waitForFunction(_fn: () => boolean, _arg: unknown, _options: any) {
            // no-op
        },

        async evaluate(_fn: (...args: any[]) => unknown, input?: any) {
            if (input?.connection) {
                return {
                    status: 'connected',
                    connection: input.connection,
                    sessionId: 'alice-rallar-session'
                };
            }

            if (input?.data) {
                await this.exposed.__blackBoxRallarEmit({
                    kind: 'diagnostic',
                    topic: 'rallar.browser.realtime.data_channel_not_open',
                    connection: 'aliceRtc',
                    actor: 'alice',
                    roomId: 'room-1',
                    data: {
                        summary: {
                            statuses: {
                                closed: 1
                            }
                        }
                    }
                });

                return {
                    status: 'sent',
                    connection: 'aliceRtc',
                    transport: 'realtime',
                    roomId: 'room-1',
                    laneId: 'realtime',
                    peerIds: ['bob-rallar-session'],
                    results: [
                        {
                            peerId: 'bob-rallar-session',
                            laneId: 'realtime',
                            result: {
                                status: 'closed',
                                bufferedAmount: 0
                            }
                        }
                    ],
                    health: []
                };
            }

            return {
                status: 'closed'
            };
        }
    };

    const provider = createRallarBrowserRtcProvider({
        harnessUrl: 'http://black-box-harness.local/rallar-browser-harness.html',
        dependencies: {
            chromium: {
                launch: async () => ({
                    async newContext() {
                        return {
                            async newPage() {
                                return page;
                            },

                            async close() {
                                // no-op
                            }
                        };
                    },

                    async close() {
                        // no-op
                    }
                })
            }
        }
    });

    const report = await executeBlackBox(
        [
            {
                RTC: {
                    request: {
                        action: 'connect',
                        connection: 'aliceRtc',
                        provider: 'rallar-browser',
                        actor: 'alice',
                        roomId: 'room-1',
                        rallar: {
                            apiBaseUrl: 'https://api.example.test',
                            username: 'alice',
                            password: 'secret',
                            transport: 'realtime',
                            laneId: 'realtime'
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
                        provider: 'rallar-browser',
                        actor: 'alice',
                        roomId: 'room-1',
                        send: {
                            data: {
                                text: 'hello bob'
                            }
                        },
                        scenarioExecutionNumber: 1,
                        interactionExecutionNumber: 2
                    },
                    response: {}
                },
                aliceSendsToBob: {}
            }
        ],
        0,
        {
            rtcProviders: {
                'rallar-browser': provider
            }
        }
    );

    expect(report.summary.failure).toEqual(1);
    expect(report.resultsByName.aliceSendsToBob[0].result).toEqual('RTC send failed');
    expect(report.resultsByName.aliceSendsToBob[0].actual.exception).toEqual('Rallar browser RTC send failed for 1 peer(s). status=closed');

    const diagnostics = report.rtcMessages.aliceRtc.map((message: any) => message.data);
    const runtimeChannelDiagnostic = diagnostics
        .find((event: any) => event.topic === 'rallar.browser.realtime.data_channel_not_open');
    const providerSendFailed = diagnostics
        .find((event: any) => event.topic === 'rallar.browser.provider.send_failed');

    expect(runtimeChannelDiagnostic?.data?.summary?.statuses?.closed).toEqual(1);
    expect(providerSendFailed?.data?.response?.results?.[0]?.result?.status).toEqual('closed');
    expect(providerSendFailed?.data?.error?.message).toEqual('Rallar browser RTC send failed for 1 peer(s). status=closed');
    expect(JSON.stringify(providerSendFailed?.data).includes('hello bob')).toEqual(false);
});
