import type { AuthSession } from '@shared/api/api-config.ts';
// @vitest-environment happy-dom
import { resolveRallarBlackBoxBootstrapConfig } from '@shared-test/rallar-bb-test/browser-control-agent-config.ts';
import type { RallarBlackBoxTestRuntimeEventInput, RallarBlackBoxTestState } from '@shared-test/rallar-bb-test/types.ts';
import type { RallarMessage, RallarMessageHandler, RallarMessagePayload } from '@shared-web/browser/messages/rallar-message-contracts.ts';
import type { RallarStartResult } from '@shared-web/browser/rallar.ts';
import { act, createElement, useLayoutEffect } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DirectRallarFacade } from '../../../apps/rallar-black-box/src/direct-rallar-operations.ts';
import type { QuickRallarTestViewModel } from '../../../apps/rallar-black-box/src/legacy/diagnostics/quick-test/quick-rallar-contracts.ts';
import {
    useQuickRallarTestController,
    type UseQuickRallarTestControllerInput
} from '../../../apps/rallar-black-box/src/legacy/diagnostics/quick-test/use-quick-rallar-test-controller.ts';
import { useWebSocketCommandCenterController } from '../../../apps/rallar-black-box/src/legacy/diagnostics/websocket/use-websocket-command-center-controller.ts';
import type { WebSocketCommandCenterViewModel } from '../../../apps/rallar-black-box/src/legacy/diagnostics/websocket/websocket-view-contracts.ts';
import { createGroupSnapshotFixture } from '../shared-web/authoritative-group-fixtures.ts';
import { createMessageDelivery } from '../shared-web/messages/test-message-delivery.ts';

const loadFacade = vi.hoisted(() => vi.fn());
const runtimeEvents = vi.hoisted(() => [] as RallarBlackBoxTestRuntimeEventInput[]);
vi.mock('../../../apps/rallar-black-box/src/legacy/rallar/load-browser-rallar-facade.ts', () => ({ loadBrowserRallarFacade: loadFacade }));
vi.mock('../../../apps/rallar-black-box/src/runtime-store.ts', () => ({
    rallarBlackBoxRuntimeStore: { recordRuntimeEvent: (event: RallarBlackBoxTestRuntimeEventInput) => runtimeEvents.push(event) },
    rallarBlackBoxProviderModeFromConfig: () => 'browser-rallar'
}));
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean; }).IS_REACT_ACT_ENVIRONMENT = true;

const state: RallarBlackBoxTestState = { status: 'idle', commandHistory: [], events: [], failures: [], resultCache: {} };
const authSession: AuthSession = { clientId: 'client', sessionId: 'session', username: 'user', accessToken: 'test-token', expiresAtEpochMs: 100_000 };
const input: UseQuickRallarTestControllerInput = {
    state,
    bootstrap: resolveRallarBlackBoxBootstrapConfig('?provider=browser-rallar', {}, ''),
    authSession,
    globalValues: {
        apiBaseUrl: 'http://localhost',
        applicationId: 'app',
        workspaceId: 'workspace',
        clientId: 'client',
        sessionId: 'session',
        roomId: 'room-a'
    },
    browserStatus: {
        signalingLabel: 'open',
        signalingTone: 'good',
        signalingDetail: '',
        rtcLabel: 'off',
        rtcTone: 'muted',
        rtcDetail: '',
        rtcGroup: '',
        rtcConnection: '',
        rtcTransport: '',
        peerSummary: ''
    },
    onGlobalValueChange: () => {}
};

function QuickHarness(props: { input: UseQuickRallarTestControllerInput; capture(view: QuickRallarTestViewModel): void; }) {
    const view = useQuickRallarTestController(props.input);
    useLayoutEffect(() => props.capture(view), [view, props]);
    return null;
}
function WebSocketHarness(props: { input: UseQuickRallarTestControllerInput; capture(view: WebSocketCommandCenterViewModel): void; }) {
    const view = useWebSocketCommandCenterController(props.input);
    useLayoutEffect(() => props.capture(view), [view, props]);
    return null;
}

describe('diagnostic controller action and lifecycle preservation', () => {
    let root: Root;
    let container: HTMLDivElement;
    let quick: QuickRallarTestViewModel;
    let websocket: WebSocketCommandCenterViewModel;
    let facade: DirectRallarFacade;
    const listeners = new Set<RallarMessageHandler<RallarMessagePayload>>();
    const sends: string[] = [];
    const joins: string[] = [];
    beforeEach(() => {
        vi.clearAllMocks();
        runtimeEvents.length = 0;
        listeners.clear();
        sends.length = 0;
        joins.length = 0;
        container = document.createElement('div');
        document.body.append(container);
        root = createRoot(container);
        facade = {
            configure: () => {},
            setDefaults: () => {},
            defaults: () => ({ applicationId: 'app' }),
            status: () => 'connected',
            auth: { restore: () => input.authSession },
            people: { list: () => [] },
            rtc: { status: unsupportedFacadeOperation },
            session: () => input.authSession,
            start: async () => ({ session: input.authSession, connected: true }),
            isConnected: () => true,
            rooms: {
                current: () => undefined,
                list: () => [],
                create: unsupportedFacadeOperation,
                join: async (room) => {
                    joins.push(String(room));
                    return createGroupSnapshotFixture({ applicationId: 'app', workspaceId: 'workspace', groupId: String(room), sessionIds: [] });
                }
            },
            messages: {
                ws: {
                    onMessage: (_selector, handler) => {
                        listeners.add(handler);
                        return () => {
                            listeners.delete(handler);
                        };
                    },
                    send: async (message) => {
                        sends.push(message.roomId ?? '');
                        return createMessageDelivery('ws', undefined).handle;
                    }
                }
            },
            ws: {
                status: () => ({
                    connectState: 'connected',
                    readyState: 'open',
                    isOpen: true,
                    reconnecting: false,
                    reconnectEnabled: true,
                    reconnectAttempts: 0,
                    maxReconnectAttempts: 5,
                    reconnectExhausted: false
                })
            }
        };
        loadFacade.mockResolvedValue(facade);
    });
    afterEach(async () => {
        await act(async () => root.unmount());
        container.remove();
        vi.useRealTimers();
        vi.unstubAllGlobals();
        vi.restoreAllMocks();
    });

    it('keeps an in-flight subscription on its original room while later actions use the current render', async () => {
        const start = Promise.withResolvers<RallarStartResult>();
        facade.start = () => start.promise;
        await act(async () =>
            root.render(createElement(QuickHarness, {
                input,
                capture: (view) => {
                    quick = view;
                }
            }))
        );
        const subscribing = Promise.withResolvers<void>();
        await act(async () => {
            void quick.subscribeWs().then(subscribing.resolve, subscribing.reject);
        });
        const changed = { ...input, globalValues: { ...input.globalValues, roomId: 'room-b' } };
        await act(async () =>
            root.render(createElement(QuickHarness, {
                input: changed,
                capture: (view) => {
                    quick = view;
                }
            }))
        );
        await act(async () => {
            start.resolve({ session: input.authSession, connected: true });
            await subscribing.promise;
        });
        expect(joins).toEqual(['room-a']);
        expect(quick.subscription?.groupId).toBe('room-a');
        facade.start = async () => ({ session: input.authSession, connected: true });
        await act(async () => quick.sendWs());
        expect(sends).toEqual(['room-b']);
        await act(async () => {
            for (const listener of listeners) {
                await listener(createDiagnosticMessage('before teardown'));
            }
        });
        expect(quick.receivedMessages.map((message) => message.payload)).toEqual([{ text: 'before teardown' }]);
        await act(async () => root.unmount());
        for (const listener of listeners) {
            await listener(createDiagnosticMessage('after teardown'));
        }
        expect(runtimeEvents.filter((event) => event.kind === 'message').map((event) => event.payload)).toEqual([
            expect.objectContaining({ payload: { text: 'before teardown' } })
        ]);
    });

    it('observes a typed receive and clears both success and timeout polling timers', async () => {
        vi.useFakeTimers();
        await act(async () =>
            root.render(createElement(QuickHarness, {
                input,
                capture: (view) => {
                    quick = view;
                }
            }))
        );
        await act(async () => quick.subscribeWs());
        const waiting = Promise.withResolvers<void>();
        await act(async () => {
            void quick.waitForReceive().then(waiting.resolve, waiting.reject);
        });
        const message = createDiagnosticMessage('hello');
        await act(async () => {
            for (const listener of listeners) {
                await listener(message);
            }
        });
        await act(async () => {
            await vi.advanceTimersByTimeAsync(100);
            await waiting.promise;
        });
        expect(quick.waitStatus).toBe('message observed');
        expect(quick.receivedMessages[0]).toMatchObject({ senderId: 'remote', payload: { text: 'hello' } });
        expect(vi.getTimerCount()).toBe(0);
        const timeout = Promise.withResolvers<void>();
        await act(async () => {
            void quick.waitForReceive().then(timeout.resolve, timeout.reject);
        });
        await act(async () => {
            await vi.advanceTimersByTimeAsync(quick.values.timeoutMs + 100);
            await timeout.promise;
        });
        expect(quick.waitStatus).toBe('timeout');
        expect(vi.getTimerCount()).toBe(0);
    });

    it('closes the registered raw socket on auth change and copies current diagnostic values', async () => {
        vi.stubGlobal('WebSocket', DiagnosticSocket);
        DiagnosticSocket.instances.length = 0;
        const clipboard = vi.spyOn(navigator.clipboard, 'writeText').mockResolvedValue(undefined);
        await act(async () =>
            root.render(createElement(WebSocketHarness, {
                input,
                capture: (view) => {
                    websocket = view;
                }
            }))
        );
        await act(async () => websocket.openMissingTicket());
        const socket = DiagnosticSocket.instances[0];
        expect(socket.url).toContain('/api/ws/session');
        await act(async () => websocket.updateValue('connection', 'current-connection'));
        websocket.copyDiagnostics();
        expect(clipboard.mock.calls.at(-1)?.[0]).toContain('current-connection');
        const changed = { ...input, authSession: { ...authSession, sessionId: 'new-session' } };
        await act(async () =>
            root.render(createElement(WebSocketHarness, {
                input: changed,
                capture: (view) => {
                    websocket = view;
                }
            }))
        );
        expect(socket.closed).toEqual([[1000, 'rallar-black-box auth cleanup']]);
    });
});

class DiagnosticSocket extends EventTarget {
    static readonly CLOSING = 2;
    static readonly CLOSED = 3;
    static readonly instances: DiagnosticSocket[] = [];
    readonly url: string;
    readonly closed: Array<[number | undefined, string | undefined]> = [];
    readyState = 1;
    constructor(url: string) {
        super();
        this.url = url;
        DiagnosticSocket.instances.push(this);
    }
    close(code?: number, reason?: string): void {
        this.closed.push([code, reason]);
        this.readyState = 3;
    }
}

function unsupportedFacadeOperation(): never {
    throw new Error('Facade operation is outside this lifecycle scenario');
}

function createDiagnosticMessage(text: string): RallarMessage<RallarMessagePayload> {
    return {
        transport: 'ws',
        senderId: 'remote',
        typeId: 'room.manual.message',
        topicId: 'room.manual.message',
        contextId: 'room-a',
        resourceId: 'message',
        receivedAtEpochMs: 1,
        payload: { text },
        raw: {
            id: { v: 2, msgId: text, senderId: 'remote', ts: 1 },
            route: { topicId: 'room.manual.message', contextId: 'room-a', resourceId: 'message' },
            payload: { typeId: 'room.manual.message', contentType: 'application/json', resource: JSON.stringify({ text }) }
        }
    };
}
