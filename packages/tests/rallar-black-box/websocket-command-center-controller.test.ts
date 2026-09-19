// @vitest-environment happy-dom
import { resolveRallarBlackBoxBootstrapConfig } from '@shared-test/rallar-bb-test/browser-control-agent-config.ts';
import type { RallarBlackBoxTestRuntimeEventInput, RallarBlackBoxTestState } from '@shared-test/rallar-bb-test/rallar-black-box-test-contracts.ts';
import type { AuthSession } from '@shared/api/api-config.ts';
import { Either } from '@shared/resilience/Either.ts';
import { act, createElement, useLayoutEffect } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AuthCommandCenterTicket } from '../../../apps/rallar-black-box/src/legacy/diagnostics/shared/auth-command-center-ticket.ts';
import { useWebSocketCommandCenterController } from '../../../apps/rallar-black-box/src/legacy/diagnostics/websocket/use-web-socket-command-center-controller.ts';
import type { UseWebSocketCommandCenterControllerInput } from '../../../apps/rallar-black-box/src/legacy/diagnostics/websocket/websocket-contracts.ts';
import type { WebSocketCommandCenterViewModel } from '../../../apps/rallar-black-box/src/legacy/diagnostics/websocket/websocket-view-contracts.ts';

const loadFacade = vi.hoisted(() => vi.fn());
const ticketRequest = vi.hoisted(() => vi.fn());
const runtimeEvents = vi.hoisted(() => [] as Array<Readonly<{ event: RallarBlackBoxTestRuntimeEventInput; lastAction: string | undefined; }>>);
vi.mock('../../../apps/rallar-black-box/src/legacy/rallar/load-browser-rallar-facade.ts', () => ({ loadBrowserRallarFacade: loadFacade }));
vi.mock('../../../apps/rallar-black-box/src/legacy/diagnostics/websocket/write-web-socket-ticket.ts', () => ({ writeWebSocketTicket: ticketRequest }));
vi.mock('../../../apps/rallar-black-box/src/runtime-store.ts', () => ({
    rallarBlackBoxRuntimeStore: {
        recordRuntimeEvent: (event: RallarBlackBoxTestRuntimeEventInput, lastAction?: string) => runtimeEvents.push({ event, lastAction })
    }
}));
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean; }).IS_REACT_ACT_ENVIRONMENT = true;

const state: RallarBlackBoxTestState = { status: 'idle', commandHistory: [], events: [], failures: [], resultCache: {} };
const authSession: AuthSession = { clientId: 'client', sessionId: 'session', username: 'user', accessToken: 'test-token', expiresAtEpochMs: 100_000 };
const input: UseWebSocketCommandCenterControllerInput = {
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
    }
};

function WebSocketHarness(props: { input: UseWebSocketCommandCenterControllerInput; capture(view: WebSocketCommandCenterViewModel): void; }) {
    const view = useWebSocketCommandCenterController(props.input);
    useLayoutEffect(() => props.capture(view), [view, props]);
    return null;
}

describe('WebSocket command-center controller actions', () => {
    let root: Root;
    let container: HTMLDivElement;
    let websocket: WebSocketCommandCenterViewModel;

    async function render(next = input): Promise<void> {
        await act(async () =>
            root.render(createElement(WebSocketHarness, {
                input: next,
                capture: (view) => {
                    websocket = view;
                }
            }))
        );
    }

    beforeEach(() => {
        vi.clearAllMocks();
        runtimeEvents.length = 0;
        RecordingSocket.instances.length = 0;
        container = document.createElement('div');
        document.body.append(container);
        root = createRoot(container);
    });
    afterEach(async () => {
        await act(async () => root.unmount());
        container.remove();
        vi.unstubAllGlobals();
        vi.restoreAllMocks();
    });

    it('retargets the default context when the group or scope changes and applies payload presets', async () => {
        await render();
        await act(async () => websocket.updateGroupId('room-b'));
        expect({ groupId: websocket.values.groupId, contextId: websocket.values.contextId }).toEqual({ groupId: 'room-b', contextId: 'room-b' });
        await act(async () => websocket.updateWsScope('world'));
        expect({ wsScope: websocket.values.wsScope, contextId: websocket.values.contextId }).toEqual({ wsScope: 'world', contextId: 'world' });
        await act(async () => websocket.selectPayloadPreset('ping'));
        expect({
            payloadPresetId: websocket.payloadPresetId,
            wsScope: websocket.values.wsScope,
            typeId: websocket.values.typeId,
            contextId: websocket.values.contextId,
            payload: JSON.parse(websocket.values.payloadText)
        }).toEqual({
            payloadPresetId: 'ping',
            wsScope: 'all',
            typeId: 'app.black-box.ws.ping',
            contextId: 'all',
            payload: { seq: 1, text: 'ping from rallar-black-box' }
        });
    });

    it('records the configured WebSocket target and reports success', async () => {
        await render();
        await act(async () => websocket.configure());
        expect({
            waitStatus: websocket.waitStatus,
            feedback: { state: websocket.actionFeedback.state, status: websocket.actionFeedback.status },
            events: runtimeEvents.map((entry) => [entry.event.topic, entry.lastAction])
        }).toEqual({
            waitStatus: 'configured',
            feedback: { state: 'success', status: 'configured' },
            events: [['rallar.direct.raw_ws.configure.completed', 'Configure WebSocket']]
        });
    });

    it('rejects sends and subscriptions with an invalid payload, target or selector before any facade work', async () => {
        await render();
        await act(async () => websocket.updateValue('payloadText', '{ not json'));
        await act(async () => websocket.send());
        expect({ state: websocket.actionFeedback.state, statusText: websocket.actionFeedback.statusText }).toEqual({
            state: 'error',
            statusText: 'invalid payload'
        });
        await act(async () => websocket.updateValue('payloadText', '{}'));
        await act(async () => websocket.updateGroupId(''));
        await act(async () => websocket.send());
        expect({ localError: websocket.localError, statusText: websocket.actionFeedback.statusText }).toEqual({
            localError: 'Room-scoped WS sends require a Group.',
            statusText: 'invalid target'
        });
        await act(async () => websocket.updateValue('typeId', ' '));
        await act(async () => websocket.subscribeWs());
        expect({ localError: websocket.localError, statusText: websocket.actionFeedback.statusText }).toEqual({
            localError: 'WS subscription requires a Type ID.',
            statusText: 'invalid selector'
        });
        expect(runtimeEvents).toEqual([]);
    });

    it('reports a missing subscription and a missing socket without failing', async () => {
        await render();
        await act(async () => websocket.unsubscribeWs());
        expect({ waitStatus: websocket.waitStatus, status: websocket.actionFeedback.status }).toEqual({
            waitStatus: 'unsubscribed',
            status: 'no subscription'
        });
        await act(async () => websocket.close('operator'));
        expect({ state: websocket.actionFeedback.state, status: websocket.actionFeedback.status }).toEqual({ state: 'success', status: 'no socket' });
        expect(runtimeEvents.map((entry) => entry.event.topic)).toEqual(['rallar.direct.raw_ws.close.requested']);
    });

    it('opens a raw socket without a ticket, then closes and reconnects it', async () => {
        vi.stubGlobal('WebSocket', RecordingSocket);
        await render();
        await act(async () => websocket.openMissingTicket());
        expect({ sockets: RecordingSocket.instances.length, status: websocket.actionFeedback.status }).toEqual({ sockets: 1, status: 'requested' });
        await act(async () => websocket.close('operator'));
        expect({ closed: RecordingSocket.instances[0].closed, status: websocket.actionFeedback.status }).toEqual({
            closed: [[1000, 'operator']],
            status: 'close requested'
        });
        ticketRequest.mockResolvedValue(Either.ofRight(createTicket()));
        await act(async () => websocket.reconnect());
        expect(RecordingSocket.instances.map((socket) => socket.url)).toEqual([
            expect.stringContaining('/api/ws/session'),
            expect.stringContaining('ticket=ticket-a')
        ]);
    });

    it('creates a WebSocket ticket and records it without the ticket secret', async () => {
        ticketRequest.mockResolvedValue(Either.ofRight(createTicket()));
        await render();
        await act(async () => websocket.createTicket());
        expect({
            ticket: websocket.ticket?.expiresAtEpochMs,
            status: websocket.actionFeedback.status,
            events: runtimeEvents.map((entry) => entry.event.topic),
            leaked: JSON.stringify(runtimeEvents).includes('ticket-a')
        }).toEqual({
            ticket: 50_000,
            status: 'created',
            events: ['rallar.direct.raw_ws.ticket.created'],
            leaked: false
        });
    });

    it('waits for the Rallar signaling socket and reports both provider refusal and an open socket', async () => {
        await render({ ...input, bootstrap: resolveRallarBlackBoxBootstrapConfig('?provider=simulated', {}, '') });
        await act(async () => websocket.waitForRallarWsOpen());
        expect({ waitStatus: websocket.waitStatus, localError: websocket.localError }).toEqual({
            waitStatus: 'rallar ws wait failed',
            localError: 'Rallar WS wait requires provider=browser-rallar.'
        });
        loadFacade.mockResolvedValue({
            configure: () => {},
            setDefaults: () => {},
            start: async () => ({ session: authSession, connected: true }),
            ws: { waitForOpen: async () => ({ status: 'open' }) }
        });
        await act(async () => root.unmount());
        root = createRoot(container);
        await render();
        await act(async () => websocket.waitForRallarWsOpen());
        expect({
            waitStatus: websocket.waitStatus,
            state: websocket.actionFeedback.state,
            events: runtimeEvents.map((entry) => entry.event.topic)
        }).toEqual({
            waitStatus: 'rallar ws open',
            state: 'success',
            events: ['rallar.direct.ws.wait_open.completed']
        });
    });

    it.each(['copyDiagnostics', 'copyRecipe'] as const)('reports unavailable clipboard through %s', async (action) => {
        vi.spyOn(navigator, 'clipboard', 'get').mockImplementation(() => Reflect.get({}, 'clipboard'));
        await render();
        await act(async () => (action === 'copyRecipe' ? websocket.copyRecipe(false) : websocket.copyDiagnostics()));
        expect(websocket.localError).toBe('Clipboard access is unavailable in this browser.');
    });

    it.each(['copyDiagnostics', 'copyRecipe'] as const)('reports rejected clipboard writes through %s', async (action) => {
        vi.spyOn(navigator.clipboard, 'writeText').mockRejectedValue(new Error('permission denied'));
        await render();
        await act(async () => (action === 'copyRecipe' ? websocket.copyRecipe(false) : websocket.copyDiagnostics()));
        expect(websocket.localError).toBe('Unable to copy to the clipboard. Check browser permissions and try again.');
    });

    it('copies a recipe only for a valid payload', async () => {
        const copied: string[] = [];
        vi.spyOn(navigator.clipboard, 'writeText').mockImplementation(async (text) => {
            copied.push(text);
        });
        await render();
        await act(async () => websocket.updateValue('payloadText', '{ not json'));
        await act(async () => websocket.copyRecipe(false));
        expect({ localError: websocket.localError !== undefined, copied }).toEqual({ localError: true, copied: [] });
        await act(async () => websocket.updateValue('payloadText', '{"text":"copied"}'));
        await act(async () => websocket.copyRecipe(true));
        expect(JSON.parse(copied.at(-1) ?? 'null')).toMatchObject({
            schemaVersion: 1,
            recipeId: 'rallar-websocket-rtc-parity-command-center'
        });
    });
});

class RecordingSocket extends EventTarget {
    static readonly CLOSING = 2;
    static readonly CLOSED = 3;
    static readonly instances: RecordingSocket[] = [];
    readonly url: string;
    readonly closed: Array<[number | undefined, string | undefined]> = [];
    readyState = 1;
    constructor(url: string) {
        super();
        this.url = url;
        RecordingSocket.instances.push(this);
    }
    close(code?: number, reason?: string): void {
        this.closed.push([code, reason]);
        this.readyState = 3;
    }
}

function createTicket(): AuthCommandCenterTicket {
    return { ticket: 'ticket-a', sessionId: 'session', expiresAtEpochMs: 50_000, issuedAtEpochMs: 1 };
}
