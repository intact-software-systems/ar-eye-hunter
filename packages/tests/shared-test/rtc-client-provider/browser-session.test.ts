import { assertEquals } from '@std/assert';
import { executeBlackBox } from '../../../shared-test/black-box-runner/execute-black-box.ts';
import { createRallarBrowserRtcProvider } from '../../../shared-test/black-box-runner/rallar-browser-rtc-provider.ts';

Deno.test('createRallarBrowserRtcProvider bridges browser runtime events into RTC report', async () => {
    const pageEvents: Record<string, Array<(event?: any) => void>> = {};
    let browserCloseCount = 0;
    let contextCloseCount = 0;
    let launchOptions: any;

    const page = {
        exposed: {} as Record<string, (event: any) => void | Promise<void>>,

        async exposeFunction(name: string, handler: (event: any) => void | Promise<void>) {
            this.exposed[name] = handler;
        },

        on(type: string, handler: (event?: any) => void) {
            pageEvents[type] = pageEvents[type] || [];
            pageEvents[type].push(handler);
        },

        async goto(_url: string, _options: any) {
            // no-op
        },

        async waitForFunction(_fn: () => boolean, _arg: unknown, _options: any) {
            // no-op
        },

        async evaluate(_fn: (...args: any[]) => unknown, input?: any) {
            if (input?.connection) {
                await this.exposed.__blackBoxRallarEmit({
                    kind: 'diagnostic',
                    topic: 'rallar.browser.runtime_loaded',
                    connection: input.connection,
                    actor: input.actor,
                    roomId: input.roomId,
                    data: {
                        source: 'fake-browser-runtime'
                    }
                });
                await this.exposed.__blackBoxRallarEmit({
                    kind: 'message',
                    topic: 'rallar.browser.realtime.message',
                    connection: input.connection,
                    actor: input.actor,
                    peerId: 'alice-session',
                    remotePeerId: 'bob-session',
                    roomId: input.roomId,
                    laneId: input.rallar?.laneId || 'realtime',
                    data: {
                        text: 'hello from browser'
                    }
                });
                return {
                    status: 'connected',
                    connection: input.connection,
                    sessionId: 'alice-session'
                };
            }

            await this.exposed.__blackBoxRallarEmit({
                kind: 'close',
                topic: 'rallar.browser.closed',
                connection: 'aliceRtc',
                actor: 'alice',
                roomId: 'room-1',
                data: {
                    status: 'closed'
                }
            });
            return {
                status: 'closed'
            };
        }
    };

    const browserContext = {
        async newPage() {
            return page;
        },

        async close() {
            contextCloseCount += 1;
        }
    };

    const browser = {
        async newContext() {
            return browserContext;
        },

        async close() {
            browserCloseCount += 1;
        }
    };

    const provider = createRallarBrowserRtcProvider({
        harnessUrl: 'http://black-box-harness.local/rallar-browser-harness.html',
        browser: {
            headless: true
        },
        dependencies: {
            chromium: {
                launch: async (options: any) => {
                    launchOptions = options;
                    return browser;
                }
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
                        action: 'wait',
                        connection: 'aliceRtc',
                        provider: 'rallar-browser',
                        actor: 'alice',
                        roomId: 'room-1',
                        scenarioExecutionNumber: 1,
                        interactionExecutionNumber: 2
                    },
                    response: {
                        connection: 'aliceRtc',
                        withinMs: 1000,
                        message: {
                            kind: 'message',
                            topic: 'rallar.browser.realtime.message',
                            data: {
                                text: 'hello from browser'
                            }
                        }
                    }
                },
                waitForBrowserMessage: {}
            },
            {
                RTC: {
                    request: {
                        action: 'close',
                        connection: 'aliceRtc',
                        provider: 'rallar-browser',
                        actor: 'alice',
                        roomId: 'room-1',
                        scenarioExecutionNumber: 1,
                        interactionExecutionNumber: 3
                    },
                    response: {}
                },
                closeAlice: {}
            },
            {
                RTC: {
                    request: {
                        action: 'wait',
                        connection: 'aliceRtc',
                        provider: 'rallar-browser',
                        actor: 'alice',
                        roomId: 'room-1',
                        scenarioExecutionNumber: 1,
                        interactionExecutionNumber: 4
                    },
                    response: {
                        connection: 'aliceRtc',
                        withinMs: 1000,
                        close: {
                            topic: 'rallar.browser.closed'
                        }
                    }
                },
                waitForBrowserClose: {}
            }
        ],
        0,
        {
            rtcProviders: {
                'rallar-browser': provider
            }
        }
    );

    assertEquals(report.summary.failure, 0);
    assertEquals(report.rtcProviderNames.includes('rallar-browser'), true);
    assertEquals(report.resultsByName.connectAlice[0].status, 'SUCCESS');
    assertEquals(report.resultsByName.waitForBrowserMessage[0].status, 'SUCCESS');
    assertEquals(report.resultsByName.closeAlice[0].status, 'SUCCESS');
    assertEquals(report.resultsByName.waitForBrowserClose[0].status, 'SUCCESS');
    assertEquals(launchOptions.headless, true);
    assertEquals(contextCloseCount, 1);
    assertEquals(browserCloseCount, 1);

    const bridgedEvents = report.rtcMessages.aliceRtc.map((message: any) => message.data);
    assertEquals(bridgedEvents.some((event: any) => event.topic === 'rallar.browser.runtime_loaded'), true);
    assertEquals(bridgedEvents.some((event: any) => event.topic === 'rallar.browser.provider.connected'), true);
    assertEquals(
        bridgedEvents.some((event: any) =>
            event.topic === 'rallar.browser.realtime.message' &&
            event.data?.text === 'hello from browser'
        ),
        true
    );

    const runtimeCloseEvent = report.rtcCloseEvents.aliceRtc
        .find((event: any) => event.topic === 'rallar.browser.closed');
    const providerCloseEvent = report.rtcCloseEvents.aliceRtc
        .find((event: any) => event.closedBy === 'rallar-browser-provider');

    assertEquals(runtimeCloseEvent?.topic, 'rallar.browser.closed');
    assertEquals(runtimeCloseEvent?.actor, 'alice');
    assertEquals(providerCloseEvent?.closedBy, 'rallar-browser-provider');
});

Deno.test('createRallarBrowserRtcProvider opens local-only CRDT without RTC connect', async () => {
    const evaluateInputs: any[] = [];
    let contextCloseCount = 0;

    const page = {
        async exposeFunction(_name: string, _handler: (event: any) => void | Promise<void>) {
            // no-op
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
            evaluateInputs.push(input);
            if (input?.action === 'open') {
                return {
                    status: 'opened',
                    handle: input.request.handle,
                    value: {
                        title: 'local-only'
                    },
                    pendingUpdateCount: 0,
                    dependencyBlockedUpdateCount: 0
                };
            }
            if (input?.action === 'destroy') {
                return {
                    status: 'destroyed',
                    handle: input.request.handle
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
                                contextCloseCount += 1;
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
                CRDT: {
                    request: {
                        action: 'open',
                        connection: 'localCrdt',
                        provider: 'rallar-browser',
                        handle: 'localDoc',
                        name: 'localDoc',
                        transport: 'local-only',
                        scenarioExecutionNumber: 1,
                        interactionExecutionNumber: 1
                    },
                    response: {}
                },
                openLocalOnlyCrdt: {}
            },
            {
                CRDT: {
                    request: {
                        action: 'destroy',
                        connection: 'localCrdt',
                        provider: 'rallar-browser',
                        handle: 'localDoc',
                        scenarioExecutionNumber: 1,
                        interactionExecutionNumber: 2
                    },
                    response: {}
                },
                destroyLocalOnlyCrdt: {}
            },
            {
                RTC: {
                    request: {
                        action: 'close',
                        connection: 'localCrdt',
                        provider: 'rallar-browser',
                        scenarioExecutionNumber: 1,
                        interactionExecutionNumber: 3
                    },
                    response: {}
                },
                closeLocalOnlyHarness: {}
            }
        ],
        0,
        {
            rtcProviders: {
                'rallar-browser': provider
            }
        }
    );

    assertEquals(report.summary.failure, 0);
    assertEquals(report.resultsByName.openLocalOnlyCrdt[0].status, 'SUCCESS');
    assertEquals(report.resultsByName.destroyLocalOnlyCrdt[0].status, 'SUCCESS');
    assertEquals(evaluateInputs.some((input) => input?.connection === 'localCrdt'), false);
    assertEquals(evaluateInputs.some((input) => input?.action === 'open'), true);
    assertEquals(contextCloseCount, 1);
});

Deno.test('createRallarBrowserRtcProvider auto-closes browser resources at run end', async () => {
    let browserCloseCount = 0;
    let contextCloseCount = 0;
    let runtimeCloseCount = 0;

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

            runtimeCloseCount += 1;
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

    assertEquals(report.summary.failure, 0);
    assertEquals(report.rtcConnections, {});
    assertEquals(runtimeCloseCount, 1);
    assertEquals(contextCloseCount, 1);
    assertEquals(browserCloseCount, 1);

    const autoCloseEvent = report.rtcCloseEvents.aliceRtc
        .find((event: any) => event.autoCloseRequested === true);
    const providerCloseEvent = report.rtcCloseEvents.aliceRtc
        .find((event: any) => event.closedBy === 'rallar-browser-provider');
    const diagnostics = report.rtcMessages.aliceRtc.map((message: any) => message.data);

    assertEquals(autoCloseEvent?.autoCloseSucceeded, true);
    assertEquals(providerCloseEvent?.closedBy, 'rallar-browser-provider');
    assertEquals(diagnostics.some((event: any) => event.topic === 'rallar.browser.provider.context_closed'), true);
    assertEquals(diagnostics.some((event: any) => event.topic === 'rallar.browser.provider.browser_closed'), true);
});

Deno.test('createRallarBrowserRtcProvider cleans up browser resources when setup fails', async () => {
    let browserCloseCount = 0;
    let contextCloseCount = 0;

    const provider = createRallarBrowserRtcProvider({
        harnessUrl: 'http://black-box-harness.local/rallar-browser-harness.html',
        dependencies: {
            chromium: {
                launch: async () => ({
                    async newContext() {
                        return {
                            async newPage() {
                                throw new Error('new page failed');
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

    assertEquals(report.summary.failure, 1);
    assertEquals(report.resultsByName.connectAlice[0].result, 'RTC connect failed');
    assertEquals(report.resultsByName.connectAlice[0].actual.exception, 'new page failed');
    assertEquals(contextCloseCount, 1);
    assertEquals(browserCloseCount, 1);

    const diagnostics = report.rtcMessages.aliceRtc.map((message: any) => message.data);
    const connectFailed = diagnostics
        .find((event: any) => event.topic === 'rallar.browser.provider.connect_failed');

    assertEquals(connectFailed?.data?.phase, 'page');
    assertEquals(diagnostics.some((event: any) => event.topic === 'rallar.browser.provider.browser_closed'), true);
});

Deno.test('createRallarBrowserRtcProvider cleans up after unexpected page close', async () => {
    const pageEvents: Record<string, Array<() => void | Promise<void>>> = {};
    let browserCloseCount = 0;
    let contextCloseCount = 0;

    const page = {
        exposed: {} as Record<string, (event: any) => void | Promise<void>>,

        async exposeFunction(name: string, handler: (event: any) => void | Promise<void>) {
            this.exposed[name] = handler;
        },

        on(type: string, handler: () => void | Promise<void>) {
            pageEvents[type] = pageEvents[type] || [];
            pageEvents[type].push(handler);
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
    const context = {
        dependencies: { now: Date.now, createUuid: () => crypto.randomUUID() },
        options: {},
        rtcConnections: {},
        rtcMessages: {},
        rtcCloseEvents: {}
    } as any;

    const interaction = {
        RTC: {},
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
            }
        },
        response: {}
    };

    const result = await provider.connect(
        interaction,
        {
            interaction,
            interactionName: 'connectAlice'
        },
        context
    );

    assertEquals(result.status, 'SUCCESS');
    await pageEvents.close[0]();
    await context.rtcConnections.aliceRtc.client.close();

    assertEquals(contextCloseCount, 1);
    assertEquals(browserCloseCount, 1);

    const pageCloseEvent = context.rtcCloseEvents.aliceRtc
        .find((event: any) => event.phase === 'page-close');
    const diagnostics = context.rtcMessages.aliceRtc.map((message: any) => message.data);

    assertEquals(pageCloseEvent?.reason, 'browser page closed');
    assertEquals(pageCloseEvent?.closedBy, 'rallar-browser-provider');
    assertEquals(diagnostics.some((event: any) => event.topic === 'rallar.browser.provider.context_closed'), true);
    assertEquals(diagnostics.some((event: any) => event.topic === 'rallar.browser.provider.browser_closed'), true);
});

Deno.test('createRallarBrowserRtcProvider records browser console and Rallar request diagnostics', async () => {
    const pageEvents: Record<string, Array<(event?: any) => void>> = {};

    const page = {
        exposed: {} as Record<string, (event: any) => void | Promise<void>>,

        async exposeFunction(name: string, handler: (event: any) => void | Promise<void>) {
            this.exposed[name] = handler;
        },

        on(type: string, handler: (event?: any) => void) {
            pageEvents[type] = pageEvents[type] || [];
            pageEvents[type].push(handler);
        },

        async goto(_url: string, _options: any) {
            pageEvents.console?.[0]?.({
                type: () => 'error',
                text: () => 'Rallar request failed in browser',
                location: () => ({
                    url: 'http://black-box-harness.local/rallar-browser-harness.html',
                    lineNumber: 42,
                    columnNumber: 7
                })
            });
            pageEvents.requestfailed?.[0]?.({
                url: () => 'https://api.example.test/rtc/connect',
                method: () => 'POST',
                failure: () => ({
                    errorText: 'net::ERR_FAILED'
                })
            });
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
            }
        ],
        0,
        {
            rtcProviders: {
                'rallar-browser': provider
            }
        }
    );

    assertEquals(report.summary.failure, 0);

    const diagnostics = report.rtcMessages.aliceRtc.map((message: any) => message.data);
    const consoleError = diagnostics
        .find((event: any) => event.topic === 'rallar.browser.console_error');
    const requestFailed = diagnostics
        .find((event: any) => event.topic === 'rallar.browser.rallar_request_failed');

    assertEquals(consoleError?.data?.text, 'Rallar request failed in browser');
    assertEquals(requestFailed?.data?.url, 'https://api.example.test/rtc/connect');
    assertEquals(requestFailed?.data?.failure?.errorText, 'net::ERR_FAILED');
});
