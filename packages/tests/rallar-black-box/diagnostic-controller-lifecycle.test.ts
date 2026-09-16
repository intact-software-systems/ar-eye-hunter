import { validateRallarBlackBoxTestCommand } from '@shared-test/rallar-bb-test/control/validate-rallar-black-box-test-command.ts';
import { RALLAR_BLACK_BOX_TEST_RECIPE_SCHEMA } from '@shared-test/rallar-bb-test/schema.ts';
import { isJsonRecordValue, validateJsonSchema } from '@shared-test/rallar-bb-test/schema/json-schema-validation.ts';
import type { AuthSession } from '@shared/api/api-config.ts';
import type { AuthCommandCenterTicket } from '../../../apps/rallar-black-box/src/legacy/diagnostics/shared/auth-command-center-ticket.ts';
// @vitest-environment happy-dom
import { resolveRallarBlackBoxBootstrapConfig } from '@shared-test/rallar-bb-test/browser-control-agent-config.ts';
import type {
    RallarBlackBoxTestRecord,
    RallarBlackBoxTestRuntimeEventInput,
    RallarBlackBoxTestState
} from '@shared-test/rallar-bb-test/rallar-black-box-test-contracts.ts';
import type { RallarMessage, RallarMessageHandler, RallarMessagePayload } from '@shared-web/browser/messages/rallar-message-contracts.ts';
import type { RallarStartResult } from '@shared-web/browser/rallar.ts';
import { act, createElement, StrictMode, useLayoutEffect } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DirectRallarFacade } from '../../../apps/rallar-black-box/src/direct-rallar-operations.ts';
import type {
    QuickRallarTestViewModel,
    UseQuickRallarTestControllerInput
} from '../../../apps/rallar-black-box/src/legacy/diagnostics/quick-test/quick-rallar-contracts.ts';
import { useQuickRallarTestController } from '../../../apps/rallar-black-box/src/legacy/diagnostics/quick-test/use-quick-rallar-test-controller.ts';
import {
    useRtcDiagnosticsController,
    type RtcDiagnosticsControllerModel
} from '../../../apps/rallar-black-box/src/legacy/diagnostics/rtc/use-rtc-diagnostics-controller.ts';
import { useWebSocketCommandCenterController } from '../../../apps/rallar-black-box/src/legacy/diagnostics/websocket/use-web-socket-command-center-controller.ts';
import type { WebSocketCommandCenterViewModel } from '../../../apps/rallar-black-box/src/legacy/diagnostics/websocket/websocket-view-contracts.ts';
import { createGroupSnapshotFixture } from '../shared-web/authoritative-group-fixtures.ts';
import { createMessageDelivery } from '../shared-web/messages/test-message-delivery.ts';

const loadFacade = vi.hoisted(() => vi.fn());
const ticketRequest = vi.hoisted(() => vi.fn());
vi.mock('../../../apps/rallar-black-box/src/legacy/diagnostics/websocket/request-web-socket-ticket.ts', () => ({ requestWebSocketTicket: ticketRequest }));
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
function RtcDiagnosticsHarness(props: { capture(view: RtcDiagnosticsControllerModel): void; }) {
    const view = useRtcDiagnosticsController({ ...input, busy: false, onSelectCommand: () => {} });
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

    it('sends and subscribes WebSocket command-center traffic through the shared browser Rallar facade', async () => {
        const sent: Array<Readonly<{ roomId: string | undefined; typeId: string; }>> = [];
        facade.messages.ws.send = async (message) => {
            sent.push({ roomId: message.roomId, typeId: message.typeId });
            return createMessageDelivery('ws', undefined).handle;
        };
        await act(async () =>
            root.render(createElement(WebSocketHarness, {
                input,
                capture: (view) => {
                    websocket = view;
                }
            }))
        );
        await act(async () => websocket.subscribeWs());
        await act(async () => websocket.send());
        expect({ localError: websocket.localError, registeredListeners: listeners.size, sent }).toEqual({
            localError: undefined,
            registeredListeners: 1,
            sent: [{ roomId: 'room-a', typeId: websocket.values.typeId }]
        });
    });

    it('connects RTC diagnostics through the shared browser Rallar facade', async () => {
        const starts: Array<Readonly<{ connect?: boolean; }>> = [];
        const rtcFacade: RtcDiagnosticsTestFacade = {
            ...facade,
            start: async (options) => {
                starts.push({ connect: options?.connect });
                return { session: authSession, connected: true };
            },
            disconnect: async () => {},
            rtc: {
                status: () => ({ laneId: 'default', knownPeerIds: [], activePeerIds: [], peerIdsWithNoReconnectableLanes: [], readyPeerIds: [], peers: [] })
            },
            realtime: { health: () => ({}) }
        };
        loadFacade.mockResolvedValue(rtcFacade);
        let rtc: RtcDiagnosticsControllerModel | undefined;
        await act(async () =>
            root.render(createElement(RtcDiagnosticsHarness, {
                capture: (view) => {
                    rtc = view;
                }
            }))
        );
        await act(async () => rtc?.runAction('Connect', 'connect'));
        expect({
            localError: rtc?.localError,
            starts,
            joins,
            topics: runtimeEvents.map((event) => event.topic)
        }).toEqual({
            localError: undefined,
            starts: [{ connect: true }],
            joins: ['room-a'],
            topics: ['rallar.direct.rtc_diagnostics.connect.completed']
        });
    });

    it('copies a canonical v1 runner recipe through the public quick-test action', async () => {
        const clipboard = vi.spyOn(navigator.clipboard, 'writeText').mockResolvedValue(undefined);
        await act(async () =>
            root.render(createElement(QuickHarness, {
                input,
                capture: (view) => {
                    quick = view;
                }
            }))
        );
        quick.copyRunnerRecipe();
        const text = clipboard.mock.calls.at(-1)?.[0];
        expect(text).toBeDefined();
        const recipe = decodeCopiedRecipe(JSON.parse(text ?? 'null'));
        expect.soft(recipe).toMatchObject({ schemaVersion: 1, metadata: { requirements: expect.arrayContaining(['logged-in browser session']) } });
        expect.soft(validateJsonSchema(RALLAR_BLACK_BOX_TEST_RECIPE_SCHEMA, recipe)).toEqual({ ok: true, errors: [] });
        expect(validateRallarBlackBoxTestCommand({ kind: 'recipe.load', recipe })).toEqual({ ok: true });
    });

    it.each(['copyDiagnostics', 'copyRunnerRecipe'] as const)('reports unavailable clipboard through %s', async (action) => {
        vi.spyOn(navigator, 'clipboard', 'get').mockImplementation(() => {
            return Reflect.get({}, 'clipboard');
        });
        await act(async () =>
            root.render(createElement(QuickHarness, {
                input,
                capture: (view) => {
                    quick = view;
                }
            }))
        );
        await act(async () => quick[action]());
        expect(quick.localError).toBe('Clipboard access is unavailable in this browser.');
    });

    it.each(['copyDiagnostics', 'copyRunnerRecipe'] as const)('reports rejected clipboard writes through %s', async (action) => {
        const write = Promise.withResolvers<void>();
        void write.promise.catch(() => {});
        vi.spyOn(navigator.clipboard, 'writeText').mockReturnValue(write.promise);
        await act(async () =>
            root.render(createElement(QuickHarness, {
                input,
                capture: (view) => {
                    quick = view;
                }
            }))
        );
        await act(async () => quick[action]());
        await act(async () => write.reject(new Error('permission denied')));
        expect(quick.localError).toBe('Unable to copy to the clipboard. Check browser permissions and try again.');
    });

    it('fences a pending copy failure from a replacement quick-test lifetime', async () => {
        const write = Promise.withResolvers<void>();
        void write.promise.catch(() => {});
        vi.spyOn(navigator.clipboard, 'writeText').mockReturnValue(write.promise);
        await act(async () =>
            root.render(createElement(QuickHarness, {
                input,
                capture: (view) => {
                    quick = view;
                }
            }))
        );
        await act(async () => quick.copyRunnerRecipe());
        await act(async () => root.render(null));
        await act(async () =>
            root.render(createElement(QuickHarness, {
                input,
                capture: (view) => {
                    quick = view;
                }
            }))
        );
        await act(async () => write.reject(new Error('late permission failure')));
        expect(quick.localError).toBeUndefined();
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

    it.each([-1_000_000, 1_000_000])('uses the supplied receive clock with ambient offset %s', async (offsetMs) => {
        vi.useFakeTimers();
        vi.setSystemTime(100_000);
        const clock = { nowMs: 100_000 + offsetMs };
        const ambientNow = Date.now;
        // The real composition captures this dependency; the in-flight action must retain it.
        Date.now = () => clock.nowMs;
        try {
            await act(async () =>
                root.render(createElement(WebSocketHarness, {
                    input,
                    capture: (view) => {
                        websocket = view;
                    }
                }))
            );
        }
        finally {
            Date.now = ambientNow;
        }
        const waiting = Promise.withResolvers<void>();
        await act(async () => {
            void websocket.waitForMessage().then(waiting.resolve, waiting.reject);
        });
        await act(async () => {
            await vi.advanceTimersByTimeAsync(100);
        });
        expect(websocket.waitStatus).toBe('waiting');
        clock.nowMs += websocket.values.timeoutMs + 1;
        await act(async () => {
            await vi.advanceTimersByTimeAsync(100);
        });
        expect(websocket.waitStatus).toBe('timeout');
        await waiting.promise;
        expect(vi.getTimerCount()).toBe(0);
    });

    it.each(['quick', 'websocket'] as const)('does not publish an abandoned %s send result', async (controller) => {
        const start = Promise.withResolvers<RallarStartResult>();
        facade.start = () => start.promise;
        await act(async () =>
            root.render(
                controller === 'quick'
                    ? createElement(QuickHarness, {
                        input,
                        capture: (view) => {
                            quick = view;
                        }
                    })
                    : createElement(WebSocketHarness, {
                        input,
                        capture: (view) => {
                            websocket = view;
                        }
                    })
            )
        );
        const sending = Promise.withResolvers<void>();
        await act(async () => {
            void (controller === 'quick' ? quick.sendWs() : websocket.send()).then(sending.resolve, sending.reject);
        });
        await act(async () => root.unmount());
        const recorded = [...runtimeEvents];
        await act(async () => {
            start.resolve({ session: authSession, connected: true });
            await sending.promise;
        });
        expect(runtimeEvents).toEqual(recorded);
        expect(sends).toEqual(['room-a']);
    });

    it.each(['quick', 'websocket'] as const)('releases a pending %s receive wait on teardown', async (controller) => {
        vi.useFakeTimers();
        await act(async () =>
            root.render(
                controller === 'quick'
                    ? createElement(QuickHarness, {
                        input,
                        capture: (view) => {
                            quick = view;
                        }
                    })
                    : createElement(WebSocketHarness, {
                        input,
                        capture: (view) => {
                            websocket = view;
                        }
                    })
            )
        );
        const waiting = Promise.withResolvers<void>();
        await act(async () => {
            void (controller === 'quick' ? quick.waitForReceive() : websocket.waitForMessage()).then(waiting.resolve, waiting.reject);
        });
        await act(async () => root.unmount());
        const pendingAfterUnmount = vi.getTimerCount();
        const events = [...runtimeEvents];
        await act(async () => {
            await vi.advanceTimersByTimeAsync((controller === 'quick' ? quick.values.timeoutMs : websocket.values.timeoutMs) + 100);
            await waiting.promise;
        });
        expect(pendingAfterUnmount).toBe(0);
        expect(runtimeEvents).toEqual(events);
    });

    it('observes traffic after the fifty-row display is full', async () => {
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
        await act(async () => {
            for (let index = 0; index < 50; index++) {
                for (const listener of listeners) {
                    await listener(createDiagnosticMessage(String(index)));
                }
            }
        });
        expect(quick.receivedMessages).toHaveLength(50);
        const waiting = Promise.withResolvers<void>();
        await act(async () => {
            void quick.waitForReceive().then(waiting.resolve, waiting.reject);
        });
        await act(async () => {
            for (const listener of listeners) {
                await listener(createDiagnosticMessage('new receive'));
            }
        });
        await act(async () => {
            await vi.advanceTimersByTimeAsync(quick.values.timeoutMs + 100);
            await waiting.promise;
        });
        expect(quick.waitStatus).toBe('message observed');
        expect(quick.receivedMessages).toHaveLength(50);
        expect(quick.receivedMessages.at(-1)?.payload).toEqual({ text: 'new receive' });
        expect(vi.getTimerCount()).toBe(0);
    });

    it.each(['quick-start', 'quick-join', 'websocket-start', 'websocket-join'] as const)(
        'releases the registered listener immediately when unmounted during %s',
        async (acquisition) => {
            const release = Promise.withResolvers<void>();
            const pending = Promise.withResolvers<void>();
            const originalStart = facade.start;
            const originalJoin = facade.rooms.join;
            if (acquisition.endsWith('start')) {
                facade.start = async (options) => {
                    await release.promise;
                    return originalStart(options);
                };
            }
            else {
                facade.rooms.join = async (room, options) => {
                    await release.promise;
                    return originalJoin(room, options);
                };
            }
            if (acquisition.startsWith('quick')) {
                await act(async () =>
                    root.render(createElement(QuickHarness, {
                        input,
                        capture: (view) => {
                            quick = view;
                        }
                    }))
                );
                await act(async () => {
                    void quick.subscribeWs().then(pending.resolve, pending.reject);
                });
            }
            else {
                await act(async () =>
                    root.render(createElement(WebSocketHarness, {
                        input,
                        capture: (view) => {
                            websocket = view;
                        }
                    }))
                );
                await act(async () => {
                    void websocket.subscribeWs().then(pending.resolve, pending.reject);
                });
            }
            expect(listeners.size).toBe(1);
            await act(async () => root.unmount());
            const observedAfterUnmount = listeners.size;
            const eventsBeforeRelease = [...runtimeEvents];
            await act(async () => {
                release.resolve();
                await pending.promise;
            });
            for (const listener of listeners) {
                await listener(createDiagnosticMessage('abandoned'));
            }
            expect({ registeredAfterUnmount: observedAfterUnmount, registeredAfterRelease: listeners.size }).toEqual({
                registeredAfterUnmount: 0,
                registeredAfterRelease: 0
            });
            expect(runtimeEvents).toEqual(eventsBeforeRelease);
        }
    );

    it.each(['quick', 'websocket'] as const)('owns %s subscriptions through StrictMode replay, auth replacement and immediate teardown', async (controller) => {
        const render = (next: UseQuickRallarTestControllerInput) =>
            controller === 'quick'
                ? createElement(QuickHarness, {
                    input: next,
                    capture: (view) => {
                        quick = view;
                    }
                })
                : createElement(WebSocketHarness, {
                    input: next,
                    capture: (view) => {
                        websocket = view;
                    }
                });
        const subscribe = () => controller === 'quick' ? quick.subscribeWs() : websocket.subscribeWs();
        await act(async () => root.render(createElement(StrictMode, null, render(input))));
        await act(async () => subscribe());
        expect(listeners.size).toBe(1);
        await act(async () => root.render(createElement(StrictMode, null, render({ ...input, authSession: { ...authSession, sessionId: 'replacement' } }))));
        expect(listeners.size).toBe(0);
        await act(async () => {
            await subscribe();
            root.unmount();
        });
        expect(listeners.size).toBe(0);
        const recorded = [...runtimeEvents];
        for (const listener of listeners) {
            await listener(createDiagnosticMessage('after immediate teardown'));
        }
        expect(runtimeEvents).toEqual(recorded);
    });

    it.each(
        [
            { teardown: 'auth change', action: 'open' },
            { teardown: 'unmount', action: 'open' },
            { teardown: 'cleanup', action: 'open' },
            { teardown: 'auth change', action: 'createTicket' },
            { teardown: 'unmount', action: 'createTicket' },
            { teardown: 'cleanup', action: 'createTicket' }
        ] as const
    )('abandons ticket acquisition %j', async ({ teardown, action }) => {
        vi.stubGlobal('WebSocket', DiagnosticSocket);
        DiagnosticSocket.instances.length = 0;
        const ticket = Promise.withResolvers<AuthCommandCenterTicket>();
        ticketRequest.mockReturnValue(ticket.promise);
        const opening = Promise.withResolvers<void>();
        await act(async () =>
            root.render(createElement(WebSocketHarness, {
                input,
                capture: (view) => {
                    websocket = view;
                }
            }))
        );
        await act(async () => {
            void websocket[action]().then(opening.resolve, opening.reject);
        });
        if (teardown === 'cleanup') {
            await act(async () => websocket.cleanup());
        }
        else if (teardown === 'unmount') {
            await act(async () => root.unmount());
        }
        else {
            await act(async () =>
                root.render(
                    createElement(WebSocketHarness, {
                        input: { ...input, authSession: { ...authSession, sessionId: 'new-session' } },
                        capture: (view) => {
                            websocket = view;
                        }
                    })
                )
            );
        }
        const eventsBeforeRelease = [...runtimeEvents];
        await act(async () => {
            ticket.resolve({ ticket: 'old-ticket', sessionId: authSession.sessionId, expiresAtEpochMs: 1_000, issuedAtEpochMs: 1 });
            await opening.promise;
        });
        expect(DiagnosticSocket.instances).toEqual([]);
        expect(runtimeEvents).toEqual(eventsBeforeRelease);
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

interface RtcDiagnosticsTestFacade extends DirectRallarFacade {
    disconnect(): Promise<void>;
    readonly realtime: { health(): Readonly<Record<string, never>>; };
}

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

function decodeCopiedRecipe(value: unknown): RallarBlackBoxTestRecord | undefined {
    return isJsonRecordValue(value) ? value : undefined;
}
