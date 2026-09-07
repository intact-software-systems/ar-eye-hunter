import { assertEquals } from '@std/assert';
import { executeBlackBox } from '../../../shared-test/black-box-runner/execute-black-box.ts';
import { createRallarBrowserRtcProvider } from '../../../shared-test/black-box-runner/rallar-browser-rtc-provider.ts';

interface BrowserRoutingPage {
    readonly exposed: Record<string, (event: any) => void | Promise<void>>;
    exposeFunction(name: string, handler: (event: any) => void | Promise<void>): Promise<void>;
    on(type: string, handler: (event?: any) => void): void;
    goto(url: string, options: any): Promise<void>;
    waitForFunction(fn: () => boolean, arg: unknown, options: any): Promise<void>;
    evaluate(fn: (...args: any[]) => unknown, input?: any): Promise<any>;
}

Deno.test('createRallarBrowserRtcProvider resolves expect.connection to realtime peerIds', async () => {
    const pagesByConnection: Record<string, any> = {};
    const sentInputs: any[] = [];

    async function evaluatePage(this: BrowserRoutingPage, _fn: (...args: any[]) => unknown, input?: any): Promise<any> {
        if (input?.connection) {
            pagesByConnection[input.connection] = this;
            return {
                status: 'connected',
                connection: input.connection,
                sessionId: input.connection === 'bobRtc'
                    ? 'bob-rallar-session'
                    : 'alice-rallar-session'
            };
        }

        sentInputs.push(input);
        await pagesByConnection.bobRtc.exposed.__blackBoxRallarEmit({
            kind: 'message',
            topic: 'rallar.browser.realtime.message',
            connection: 'bobRtc',
            actor: 'bob',
            peerId: 'bob-rallar-session',
            remotePeerId: 'alice-rallar-session',
            roomId: 'room-1',
            laneId: 'realtime',
            data: input.data
        });

        return {
            status: 'sent',
            peerIds: input.peerIds,
            results: [
                {
                    peerId: input.peerIds?.[0],
                    laneId: 'realtime',
                    result: {
                        status: 'sent',
                        bufferedAmount: 0
                    }
                }
            ]
        };
    }

    function createPage(): BrowserRoutingPage {
        return {
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

            evaluate: evaluatePage
        };
    }

    const pages = [createPage(), createPage()];
    let pageIndex = 0;

    const provider = createRallarBrowserRtcProvider({
        harnessUrl: 'http://black-box-harness.local/rallar-browser-harness.html',
        dependencies: {
            chromium: {
                launch: async () => ({
                    async newContext() {
                        return {
                            async newPage() {
                                const page = pages[pageIndex];
                                pageIndex += 1;
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
                        action: 'connect',
                        connection: 'bobRtc',
                        provider: 'rallar-browser',
                        actor: 'bob',
                        roomId: 'room-1',
                        rallar: {
                            apiBaseUrl: 'https://api.example.test',
                            username: 'bob',
                            password: 'secret',
                            transport: 'realtime',
                            laneId: 'realtime'
                        },
                        scenarioExecutionNumber: 1,
                        interactionExecutionNumber: 2
                    },
                    response: {}
                },
                connectBob: {}
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
                        interactionExecutionNumber: 3
                    },
                    response: {
                        connection: 'bobRtc',
                        withinMs: 1000,
                        message: {
                            kind: 'message',
                            topic: 'rallar.browser.realtime.message',
                            data: {
                                text: 'hello bob'
                            }
                        }
                    }
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

    assertEquals(report.summary.failure, 0);
    assertEquals(report.resultsByName.aliceSendsToBob[0].status, 'SUCCESS');
    assertEquals(sentInputs[0].peerIds, ['bob-rallar-session']);
    assertEquals(sentInputs[0].roomId, 'room-1');
    assertEquals(sentInputs[0].data, {
        text: 'hello bob'
    });
});

Deno.test('createRallarBrowserRtcProvider resolves expect.connection to messages.rtc nextHopPeerIds', async () => {
    const pagesByConnection: Record<string, any> = {};
    const connectInputs: any[] = [];
    const sentInputs: any[] = [];
    const roomRef = {
        applicationId: 'app-1',
        workspaceId: 'workspace-a',
        groupId: 'room-1'
    };

    async function evaluatePage(this: BrowserRoutingPage, _fn: (...args: any[]) => unknown, input?: any): Promise<any> {
        if (input?.connection) {
            connectInputs.push(input);
            pagesByConnection[input.connection] = this;
            return {
                status: 'connected',
                connection: input.connection,
                sessionId: input.connection === 'bobRtc'
                    ? 'bob-rallar-session'
                    : 'alice-rallar-session'
            };
        }

        if (input?.nextHopPeerIds) {
            sentInputs.push(input);
            await pagesByConnection.bobRtc.exposed.__blackBoxRallarEmit({
                kind: 'message',
                topic: 'rallar.browser.messages.rtc.message',
                connection: 'bobRtc',
                actor: 'bob',
                peerId: 'bob-rallar-session',
                remotePeerId: 'alice-rallar-session',
                senderId: 'alice-rallar-session',
                roomId: 'room-1',
                typeId: 'chat.message',
                topicId: 'chat',
                contextId: 'room-1',
                resourceId: 'message-1',
                data: input.payload
            });

            return {
                status: 'sent',
                nextHopPeerIds: input.nextHopPeerIds,
                message: {
                    payload: {
                        typeId: 'chat.message'
                    }
                }
            };
        }

        return {
            status: 'closed'
        };
    }

    function createPage(): BrowserRoutingPage {
        return {
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

            evaluate: evaluatePage
        };
    }

    const pages = [createPage(), createPage()];
    let pageIndex = 0;

    const provider = createRallarBrowserRtcProvider({
        harnessUrl: 'http://black-box-harness.local/rallar-browser-harness.html',
        dependencies: {
            chromium: {
                launch: async () => ({
                    async newContext() {
                        return {
                            async newPage() {
                                const page = pages[pageIndex];
                                pageIndex += 1;
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
                        roomRef,
                        rallar: {
                            apiBaseUrl: 'https://api.example.test',
                            username: 'alice',
                            password: 'secret',
                            transport: 'messages.rtc',
                            applicationId: 'app-1',
                            workspaceId: 'workspace-a',
                            roomRef,
                            typeId: 'chat.message',
                            topicId: 'chat'
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
                        action: 'connect',
                        connection: 'bobRtc',
                        provider: 'rallar-browser',
                        actor: 'bob',
                        roomId: 'room-1',
                        roomRef,
                        rallar: {
                            apiBaseUrl: 'https://api.example.test',
                            username: 'bob',
                            password: 'secret',
                            transport: 'messages.rtc',
                            applicationId: 'app-1',
                            workspaceId: 'workspace-a',
                            roomRef,
                            typeId: 'chat.message',
                            topicId: 'chat'
                        },
                        scenarioExecutionNumber: 1,
                        interactionExecutionNumber: 2
                    },
                    response: {}
                },
                connectBob: {}
            },
            {
                RTC: {
                    request: {
                        action: 'send',
                        connection: 'aliceRtc',
                        provider: 'rallar-browser',
                        actor: 'alice',
                        roomId: 'room-1',
                        roomRef,
                        minSnapshotVersion: 9,
                        send: {
                            payload: {
                                text: 'hello bob'
                            }
                        },
                        scenarioExecutionNumber: 1,
                        interactionExecutionNumber: 3
                    },
                    response: {
                        connection: 'bobRtc',
                        withinMs: 1000,
                        message: {
                            kind: 'message',
                            topic: 'rallar.browser.messages.rtc.message',
                            typeId: 'chat.message',
                            topicId: 'chat',
                            data: {
                                text: 'hello bob'
                            }
                        }
                    }
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

    assertEquals(report.summary.failure, 0);
    assertEquals(report.resultsByName.aliceSendsToBob[0].status, 'SUCCESS');
    assertEquals(report.resultsByName.aliceSendsToBob[0].actual.diagnostics.roomRef, roomRef);
    assertEquals(
        report.resultsByName.aliceSendsToBob[0].actual.sendResult.nextHopPeerIds,
        ['bob-rallar-session']
    );
    assertEquals(connectInputs[0].roomRef, roomRef);
    assertEquals(connectInputs[0].rallar.scope, {
        applicationId: 'app-1',
        workspaceId: 'workspace-a'
    });
    assertEquals(sentInputs[0].nextHopPeerIds, ['bob-rallar-session']);
    assertEquals(sentInputs[0].peerIds, undefined);
    assertEquals(sentInputs[0].roomId, 'room-1');
    assertEquals(sentInputs[0].roomRef, roomRef);
    assertEquals(sentInputs[0].minSnapshotVersion, 9);
    assertEquals(sentInputs[0].payload, {
        text: 'hello bob'
    });
});
