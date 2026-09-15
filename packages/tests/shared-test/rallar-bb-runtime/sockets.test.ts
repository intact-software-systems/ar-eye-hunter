import { describe, expect, it } from 'vitest';
import {
    createRallarBlackBoxBrowserTestRuntime,
    selectRallarBlackBoxEvents,
    selectRallarBlackBoxMessages,
    type RallarBlackBoxBrowserRallarConnectionConfig,
    type RallarBlackBoxBrowserRallarRuntime
} from '../../../shared-test/rallar-bb-test/mod.ts';
import { createBrowserRallarRequiredMethodsTestDouble } from '.././browser-rallar-required-methods-test-double.ts';
import { BrowserWebSocketFixture } from './browser-websocket-fixture.ts';

describe('rallar-bb runtime sockets', () => {
    it('executes browser-native WebSocket commands through the adapter', async () => {
        const sockets: BrowserWebSocketFixture[] = [];
        const runtime = createRallarBlackBoxBrowserTestRuntime({
            webSocketFactory: (url) => {
                const socket = new BrowserWebSocketFixture(url, { echoMessages: true, bufferedAmountAfterSend: 42 });
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

    it('refuses a ws.send without data before writing to the raw socket or the Rallar signaling', async () => {
        const sockets: BrowserWebSocketFixture[] = [];
        const signalingSends: Parameters<NonNullable<RallarBlackBoxBrowserRallarRuntime['sendWs']>>[0][] = [];
        const runtime = createRallarBlackBoxBrowserTestRuntime({
            webSocketFactory: (url) => {
                const socket = new BrowserWebSocketFixture(url, {});
                sockets.push(socket);
                return socket;
            },
            rallarRuntime: {
                ...createBrowserRallarRequiredMethodsTestDouble(),
                connect: async () => ({ connected: true }),
                send: async () => ({ sent: true }),
                sendWs: async (input) => {
                    signalingSends.push(input);
                    return { status: 'sent', transport: 'ws' };
                },
                refreshRoom: async () => undefined,
                close: async () => ({ closed: true }),
                health: async () => ({ connected: true })
            }
        });
        await runtime.execute({ kind: 'ws.open', commandId: 'ws-open', connection: 'control', url: 'wss://control.example.test/ws' });

        const raw = await runtime.execute({ kind: 'ws.send', commandId: 'ws-send-raw', connection: 'control', data: undefined });
        const signaling = await runtime.execute({ kind: 'ws.send', commandId: 'ws-send-rallar', connection: 'rallarApi', data: undefined });

        for (const result of [raw, signaling]) {
            expect(result.ok).toBe(false);
            expect(result.error).toMatchObject({ code: 'RALLAR_BB_WS_SEND_DATA_REQUIRED', message: 'ws.send requires data.' });
        }
        expect(sockets[0].sent).toEqual([]);
        expect(signalingSends).toEqual([]);
    });

    it('keeps ws.send on an open raw socket in browser Rallar provider mode', async () => {
        const sockets: BrowserWebSocketFixture[] = [];
        const runtime = createRallarBlackBoxBrowserTestRuntime({
            webSocketFactory: (url) => {
                const socket = new BrowserWebSocketFixture(url, { echoMessages: true });
                sockets.push(socket);
                return socket;
            },
            rallarRuntime: {
                ...createBrowserRallarRequiredMethodsTestDouble(),
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
        const sockets: BrowserWebSocketFixture[] = [];
        const rallarCalls: string[] = [];
        const runtime = createRallarBlackBoxBrowserTestRuntime({
            webSocketFactory: (url) => {
                const socket = new BrowserWebSocketFixture(url);
                sockets.push(socket);
                return socket;
            },
            rallarRuntime: {
                ...createBrowserRallarRequiredMethodsTestDouble(),
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
                schemaVersion: 1,
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
        const sends: Parameters<NonNullable<RallarBlackBoxBrowserRallarRuntime['sendWs']>>[0][] = [];
        const runtime = createRallarBlackBoxBrowserTestRuntime({
            rallarRuntime: {
                ...createBrowserRallarRequiredMethodsTestDouble(),
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
        const sockets: BrowserWebSocketFixture[] = [];
        const connects: RallarBlackBoxBrowserRallarConnectionConfig[] = [];
        const sends: Parameters<NonNullable<RallarBlackBoxBrowserRallarRuntime['sendWs']>>[0][] = [];
        const runtime = createRallarBlackBoxBrowserTestRuntime({
            webSocketFactory: (url) => {
                const socket = new BrowserWebSocketFixture(url);
                sockets.push(socket);
                return socket;
            },
            rallarRuntime: {
                ...createBrowserRallarRequiredMethodsTestDouble(),
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
});
