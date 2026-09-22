// @vitest-environment happy-dom
import type { RallarBlackBoxTestState } from '@shared-test/rallar-bb-test/rallar-black-box-test-contracts.ts';
import type { AuthSession } from '@shared/api/api-config.ts';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { WebSocketCommandCenterView } from '../../../apps/rallar-black-box/src/legacy/diagnostics/websocket/web-socket-command-center-view.tsx';
import type { WebSocketCommandCenterValues } from '../../../apps/rallar-black-box/src/legacy/diagnostics/websocket/websocket-contracts.ts';
import type { WebSocketCommandCenterViewModel } from '../../../apps/rallar-black-box/src/legacy/diagnostics/websocket/websocket-view-contracts.ts';
import type { RallarBrowserStatusSummary } from '../../../apps/rallar-black-box/src/legacy/shell/rallar-browser-status.ts';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean; }).IS_REACT_ACT_ENVIRONMENT = true;

const state: RallarBlackBoxTestState = { status: 'idle', commandHistory: [], events: [], failures: [], resultCache: {} };
const authSession: AuthSession = { clientId: 'client', sessionId: 'session', username: 'user', accessToken: 'view-secret-token', expiresAtEpochMs: 100_000 };
const browserStatus: RallarBrowserStatusSummary = {
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
};
const values: WebSocketCommandCenterValues = {
    apiBaseUrl: 'https://api.example.test',
    connection: 'rallarApi',
    applicationId: 'app',
    workspaceId: 'workspace',
    groupId: 'room-a',
    wsScope: 'room',
    typeId: 'room.manual.message',
    topicId: 'room.chat',
    contextId: 'room-a',
    resourceId: 'resource-a',
    wsUrl: 'wss://api.example.test/api/ws/custom',
    protocols: 'json',
    payloadText: '{"text":"hello"}',
    timeoutMs: 5_000,
    closeCode: 4001,
    closeReason: 'operator close'
};

function createViewModel(invoked: string[], overrides: Partial<WebSocketCommandCenterViewModel>): WebSocketCommandCenterViewModel {
    const record = (name: string) => async () => {
        invoked.push(name);
    };
    return {
        providerMode: 'browser-rallar',
        values,
        payloadPresetId: 'group-message',
        busyAction: undefined,
        localError: undefined,
        actionFeedback: { state: 'success', label: 'Subscribe WS', message: 'Subscribed to room.chat.' },
        waitStatus: 'subscribed',
        ticket: { expiresAtEpochMs: 60_000 },
        subscription: { label: 'room.chat / room.manual.message', groupId: 'room-a', subscribedAtEpochMs: 1_000 },
        diagnostics: {
            readyState: 'OPEN',
            status: 'open',
            statusLabel: 'open',
            inboundCount: 2,
            outboundCount: 1,
            errorCount: 0,
            closeCode: 1000,
            closeReason: 'done',
            recentEvents: [{
                eventId: 'event-a',
                kind: 'message',
                topic: 'rallar.direct.ws.message',
                atEpochMs: 2_000,
                severity: 'info',
                payload: { token: 'view-secret-token' }
            }],
            receivedMessages: [{
                eventId: 'received-a',
                atEpochMs: 2_000,
                senderId: 'remote',
                roomId: 'room-a',
                typeId: 'room.manual.message',
                topicId: 'room.chat',
                contextId: 'room-a',
                resourceId: 'resource-a',
                payload: { text: 'received payload' }
            }]
        },
        activePreset: { label: 'Group Message - current group', description: 'Broadcast payload.' },
        canSendViaRallarSignaling: true,
        routePreview: {
            destination: 'Group room-a',
            destinationDetail: 'Application app / workspace workspace',
            selector: 'room.chat / room.manual.message',
            selectorDetail: 'selector detail',
            transport: 'Rallar app WS',
            transportDetail: 'Uses open Rallar signaling for rallarApi',
            sendLabel: 'Send JSON to group'
        },
        subscriptionStatusLabel: 'listening',
        subscriptionStatusTone: 'good',
        receiveStatusText: 'Listening for room.chat / room.manual.message at Group room-a.',
        payloadResult: { ok: true },
        updateValue: (key, value) => {
            invoked.push(`updateValue:${key}=${String(value)}`);
        },
        updateGroupId: (groupId) => {
            invoked.push(`updateGroupId:${groupId}`);
        },
        updateWsScope: (scope) => {
            invoked.push(`updateWsScope:${scope}`);
        },
        selectPayloadPreset: (presetId) => {
            invoked.push(`selectPayloadPreset:${presetId}`);
        },
        configure: record('configure'),
        open: async (url) => {
            invoked.push(`open:${url}`);
        },
        send: record('send'),
        close: async (reason) => {
            invoked.push(`close:${reason}`);
        },
        reconnect: record('reconnect'),
        cleanup: record('cleanup'),
        subscribeWs: record('subscribeWs'),
        unsubscribeWs: () => {
            invoked.push('unsubscribeWs');
        },
        createTicket: record('createTicket'),
        waitForMessage: record('waitForMessage'),
        waitForRallarWsOpen: record('waitForRallarWsOpen'),
        copyDiagnostics: record('copyDiagnostics'),
        copyRecipe: async (includeRtcParity) => {
            invoked.push(`copyRecipe:${includeRtcParity}`);
        },
        openMissingTicket: record('openMissingTicket'),
        ...overrides
    };
}

describe('WebSocket command-center view', () => {
    let root: Root;
    let container: HTMLDivElement;
    const invoked: string[] = [];

    async function render(overrides: Partial<WebSocketCommandCenterViewModel> = {}, busy = false): Promise<void> {
        await act(async () =>
            root.render(createElement(WebSocketCommandCenterView, {
                state,
                authSession,
                browserStatus,
                busy,
                model: createViewModel(invoked, overrides)
            }))
        );
    }

    function button(name: string): HTMLButtonElement {
        const match = [...container.querySelectorAll('button')].find((candidate) => candidate.textContent?.trim() === name);
        if (!match) {
            throw new Error(`Missing ${name} button`);
        }
        return match;
    }

    function field(label: string): HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement {
        const owner = [...container.querySelectorAll('label')].find((candidate) => candidate.querySelector('span')?.textContent === label);
        const control = owner?.querySelector('input, select, textarea');
        if (!(control instanceof HTMLInputElement || control instanceof HTMLSelectElement || control instanceof HTMLTextAreaElement)) {
            throw new Error(`Missing ${label} field`);
        }
        return control;
    }

    function metric(label: string): string | undefined {
        return [...container.querySelectorAll('.metric')]
            .filter((candidate) => candidate.querySelector('span')?.textContent === label)
            .map((candidate) => candidate.querySelector('strong')?.textContent ?? '')
            .at(0);
    }

    beforeEach(() => {
        invoked.length = 0;
        container = document.createElement('div');
        document.body.append(container);
        root = createRoot(container);
    });
    afterEach(async () => {
        await act(async () => root.unmount());
        container.remove();
    });

    it('renders the configured inputs, live subscription, route, received messages, status and redacted event log', async () => {
        await render();

        expect({
            heading: container.querySelector('h2')?.textContent,
            wsUrl: field('WebSocket URL').value,
            closeReason: field('Close Reason').value,
            scope: field('WS Scope').value,
            payload: field('Payload JSON').value,
            subscribed: metric('WS subscribed'),
            listeningGroup: metric('Listening group'),
            received: metric('Received'),
            inbound: metric('Inbound'),
            closeCode: metric('Close code'),
            ticket: metric('Ticket'),
            feedbackLive: container.querySelector('[aria-live="polite"]') !== null,
            routeDestination: container.querySelector('[aria-label="WebSocket route preview"] strong')?.textContent,
            receivedTitle: container.querySelector('.websocket-received-row strong')?.textContent,
            signalingHint: container.textContent?.includes('Send JSON uses rallar.messages.ws.send'),
            eventTopic: container.querySelector('.websocket-event-row strong')?.textContent,
            leaked: container.textContent?.includes('view-secret-token')
        }).toEqual({
            heading: 'WebSocket Command Center',
            wsUrl: values.wsUrl,
            closeReason: 'operator close',
            scope: 'room',
            payload: '{"text":"hello"}',
            subscribed: 'yes',
            listeningGroup: 'room-a',
            received: '1',
            inbound: '2',
            closeCode: '1000',
            ticket: 'redacted',
            feedbackLive: true,
            routeDestination: 'Group room-a',
            receivedTitle: 'room.chat / room.manual.message',
            signalingHint: true,
            eventTopic: 'rallar.direct.ws.message',
            leaked: false
        });
    });

    it('passes the configured values to every raw socket and message action', async () => {
        await render();
        for (
            const name of [
                'Send JSON to group',
                'Subscribe WS',
                'Unsubscribe WS',
                'Wait Rallar WS open',
                'Wait for message',
                'Copy WS recipe',
                'Copy WS/RTC compare recipe',
                'Configure WS',
                'Create WS ticket',
                'Open',
                'Open API WS',
                'Reconnect',
                'Close',
                'Cleanup',
                'Missing ticket open',
                'Copy diagnostics'
            ]
        ) {
            await act(async () => button(name).click());
        }

        expect(invoked).toEqual([
            'send',
            'subscribeWs',
            'unsubscribeWs',
            'waitForRallarWsOpen',
            'waitForMessage',
            'copyRecipe:false',
            'copyRecipe:true',
            'configure',
            'createTicket',
            `open:${values.wsUrl}`,
            'open:wss://api.example.test/api/ws/%7Bauth.sessionId%7D?ticket={auth.wsTicket}',
            'reconnect',
            'close:operator close',
            'cleanup',
            'openMissingTicket',
            'copyDiagnostics'
        ]);
    });

    it('routes edits to the matching update and disables actions while busy', async () => {
        await render({}, true);
        const setGroup = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
        await act(async () => {
            setGroup?.call(field('Group'), 'room-b');
            field('Group').dispatchEvent(new Event('input', { bubbles: true }));
        });

        expect({
            invoked,
            sendDisabled: button('Send JSON to group').disabled,
            openDisabled: button('Open').disabled,
            copyDisabled: button('Copy WS recipe').disabled
        }).toEqual({
            invoked: ['updateGroupId:room-b'],
            sendDisabled: true,
            openDisabled: true,
            copyDisabled: false
        });
    });

    it('shows the local error or the payload parse error instead of the signaling hint', async () => {
        await render({ payloadResult: { ok: false, error: 'Unexpected token' } });

        expect({
            status: container.querySelector('.workbench-error')?.textContent,
            hint: container.textContent?.includes('Send JSON uses rallar.messages.ws.send')
        }).toEqual({ status: 'Unexpected token', hint: true });
    });
});
