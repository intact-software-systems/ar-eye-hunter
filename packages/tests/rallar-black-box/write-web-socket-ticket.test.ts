// @vitest-environment happy-dom
import { resolveRallarBlackBoxBootstrapConfig } from '@shared-test/rallar-bb-test/browser-control-agent-config.ts';
import type {
    RallarBlackBoxTestJsonValue,
    RallarBlackBoxTestRuntimeEventInput,
    RallarBlackBoxTestState
} from '@shared-test/rallar-bb-test/rallar-black-box-test-contracts.ts';
import type { AuthSession } from '@shared/api/api-config.ts';
import { act, createElement, useLayoutEffect } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useWebSocketCommandCenterController } from '../../../apps/rallar-black-box/src/legacy/diagnostics/websocket/use-web-socket-command-center-controller.ts';
import type { UseWebSocketCommandCenterControllerInput } from '../../../apps/rallar-black-box/src/legacy/diagnostics/websocket/websocket-contracts.ts';
import type { WebSocketCommandCenterViewModel } from '../../../apps/rallar-black-box/src/legacy/diagnostics/websocket/websocket-view-contracts.ts';
import { writeWebSocketTicket } from '../../../apps/rallar-black-box/src/legacy/diagnostics/websocket/write-web-socket-ticket.ts';

interface StubResponse {
    readonly status: number;
    readonly statusText: string;
    readonly body: RallarBlackBoxTestJsonValue;
}

const runtimeEvents = vi.hoisted(() => [] as RallarBlackBoxTestRuntimeEventInput[]);
vi.mock('../../../apps/rallar-black-box/src/runtime-store.ts', () => ({
    rallarBlackBoxRuntimeStore: { recordRuntimeEvent: (event: RallarBlackBoxTestRuntimeEventInput) => runtimeEvents.push(event) },
    rallarBlackBoxProviderModeFromConfig: () => 'browser-rallar'
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

class RecordingSocket extends EventTarget {
    static readonly CLOSING = 2;
    static readonly CLOSED = 3;
    static readonly urls: string[] = [];
    readyState = 1;
    constructor(url: string) {
        super();
        RecordingSocket.urls.push(url);
    }
    close(): void {
        this.readyState = 3;
    }
}

describe('WebSocket ticket writes through the raw-socket actions', () => {
    let root: Root;
    let container: HTMLDivElement;
    let websocket: WebSocketCommandCenterViewModel;
    const requestedPaths: string[] = [];
    let response: StubResponse;

    async function render(next: UseWebSocketCommandCenterControllerInput): Promise<void> {
        await act(async () =>
            root.render(createElement(WebSocketHarness, {
                input: next,
                capture: (view) => {
                    websocket = view;
                }
            }))
        );
    }

    function outcome(): Readonly<Record<string, string | number | boolean | undefined>> {
        return {
            localError: websocket.localError,
            feedbackState: websocket.actionFeedback.state,
            feedbackLabel: websocket.actionFeedback.label,
            feedbackMessage: websocket.actionFeedback.message,
            waitStatus: websocket.waitStatus,
            ticketExpiresAt: websocket.ticket?.expiresAtEpochMs,
            sockets: RecordingSocket.urls.length
        };
    }

    beforeEach(() => {
        runtimeEvents.length = 0;
        requestedPaths.length = 0;
        RecordingSocket.urls.length = 0;
        response = { status: 200, statusText: 'OK', body: { ticket: 'ticket-a', sessionId: 'session', expiresAtEpochMs: 90_000 } };
        vi.stubGlobal('WebSocket', RecordingSocket);
        vi.stubGlobal('fetch', async (url: string) => {
            requestedPaths.push(new URL(url).pathname.replace(/\/requests\/[^/]+$/, '/requests/{requestId}'));
            return new Response(JSON.stringify(response.body), {
                status: response.status,
                statusText: response.statusText,
                headers: { 'content-type': 'application/json' }
            });
        });
        vi.spyOn(Date, 'now').mockReturnValue(42_000);
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

    it('stores a created ticket and reports its expiry', async () => {
        await render(input);
        await act(async () => websocket.createTicket());

        expect({ requestedPaths, ...outcome(), events: runtimeEvents.map((event) => event.topic) }).toEqual({
            requestedPaths: ['/api/auth/ws-ticket/requests/{requestId}'],
            localError: undefined,
            feedbackState: 'success',
            feedbackLabel: 'Create WS ticket',
            feedbackMessage: expect.stringContaining('Ticket expires at'),
            waitStatus: 'idle',
            ticketExpiresAt: 90_000,
            sockets: 0,
            events: ['rallar.direct.raw_ws.ticket.created']
        });
    });

    it('stamps the ticket with the time its response arrived, read from the injected clock', async () => {
        const requested = await writeWebSocketTicket({
            apiBaseUrl: 'http://localhost',
            authSession,
            requestId: 'ticket-request-000001',
            timeoutMs: 1_000,
            nowMs: () => 7_000
        });

        expect(requested.foldRight((ticket) => ticket)).toEqual({
            ticket: 'ticket-a',
            sessionId: 'session',
            expiresAtEpochMs: 90_000,
            issuedAtEpochMs: 7_000
        });
    });

    it.each([
        {
            name: 'an unauthorized response',
            next: input,
            stub: { status: 401, statusText: 'Unauthorized', body: { error: 'unauthorized' } },
            message: 'HTTP 401 Unauthorized'
        },
        {
            name: 'a response without a ticket',
            next: input,
            stub: { status: 200, statusText: 'OK', body: { sessionId: 'session' } },
            message: 'WS ticket request returned 200'
        },
        {
            name: 'a signed-out browser',
            next: { ...input, authSession: undefined },
            stub: { status: 200, statusText: 'OK', body: {} },
            message: 'Rallar Server request requires a browser auth session.'
        }
    ])('reports $name as a visible ticket failure for create and open', async ({ next, stub, message }) => {
        response = stub;
        await render(next);
        await act(async () => websocket.createTicket());
        const created = outcome();
        await act(async () => websocket.open(websocket.values.wsUrl));

        expect({ created, opened: outcome() }).toEqual({
            created: {
                localError: message,
                feedbackState: 'error',
                feedbackLabel: 'Create WS ticket',
                feedbackMessage: message,
                waitStatus: 'idle',
                ticketExpiresAt: undefined,
                sockets: 0
            },
            opened: {
                localError: message,
                feedbackState: 'error',
                feedbackLabel: 'Open WebSocket',
                feedbackMessage: message,
                waitStatus: 'raw ws open failed',
                ticketExpiresAt: undefined,
                sockets: 0
            }
        });
    });
});
