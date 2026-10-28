import type { BlackBoxRallarRuntime } from '@shared-test/black-box-runner/browser/rallar-browser-runtime/black-box-rallar-runtime-contract.ts';
import type { RallarMessage, RallarMessagePayload } from '@shared-web/browser/messages/rallar-message-contracts.ts';
import type { GroupRef } from '@shared/api/group-types.ts';
import {
    beforeEach,
    expect,
    it,
    onTestFinished,
    vi
} from 'vitest';

import {
    events,
    facade,
    loadRuntime,
    resetFacade
} from './browser-rallar-runtime-test-harness.ts';

const SENTINEL = 'payload must never enter diagnostics';
const secretPayload = { secret: SENTINEL };

const roomRef: GroupRef = {
    applicationId: 'app-1',
    workspaceId: 'workspace-a',
    groupId: 'bb-group'
};

beforeEach(() => {
    resetFacade();
});

it('keeps every application payload out of the lane diagnostics while message evidence carries it', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    onTestFinished(() => warnSpy.mockRestore());
    const runtime = await loadConnectedRuntime();
    onTestFinished(async () => {
        await runtime.close();
    });

    await runtime.sendWs({ scope: 'room', roomId: 'bb-group', typeId: 'room.manual.message', payload: secretPayload });
    await runtime.sendMessage({
        connection: 'aliceRtc',
        carrier: 'rtc-with-ws-fallback',
        typeId: 'alm.conformance',
        topicId: 'alm',
        payload: secretPayload,
        handleId: 'handle-1',
        timeoutMs: 100
    });
    await deliverInboundMessages();
    console.warn('Unhandled WS message', secretPayload);
    console.warn(secretPayload);

    const diagnostics = events.filter((event) => event.kind === 'diagnostic');
    const messages = events.filter((event) => event.kind === 'message');
    expect(diagnostics.length).toBeGreaterThan(0);
    expect(JSON.stringify(diagnostics)).not.toContain(SENTINEL);
    expect(JSON.stringify(messages)).toContain(SENTINEL);
    expect(diagnostics.filter((event) => event.topic === 'rallar.browser.ws.unhandled_message').map((event) => event.data))
        .toEqual([{ pattern: 'unhandled-ws-message', source: 'console.warn' }]);
});

async function loadConnectedRuntime(): Promise<BlackBoxRallarRuntime> {
    const runtime = await loadRuntime();
    await runtime.connect({
        connection: 'aliceRtc',
        actor: 'alice',
        roomId: 'bb-group',
        roomRef,
        rallar: {
            apiBaseUrl: 'https://api.example.test',
            username: 'alice',
            password: 'secret',
            applicationId: 'app-1',
            workspaceId: 'workspace-a',
            roomRef
        }
    });
    return runtime;
}

async function deliverInboundMessages(): Promise<void> {
    const wsHandler = facade.records.wsMessageSubscriptions[0]?.[1];
    const typedRtcHandler = facade.records.typedRtcHandlers[0];
    if (wsHandler === undefined || typedRtcHandler === undefined) {
        throw new Error('The ws and typed rtc subscriptions were not recorded.');
    }
    const inbound = inboundMessage();
    await wsHandler(inbound);
    await typedRtcHandler(inbound.payload, { ...inbound, typeId: 'alm.conformance', topicId: 'alm', transport: 'rtc' });
}

function inboundMessage(): RallarMessage<RallarMessagePayload> {
    return {
        transport: 'ws',
        roomId: 'bb-group',
        senderId: 'bob-session',
        traceId: 'trace-payload-free',
        typeId: 'room.manual.message',
        topicId: 'room.manual.message',
        contextId: 'bb-group',
        resourceId: 'message-1',
        payload: secretPayload,
        raw: {
            id: { v: 4, msgId: 'ws-message-1', ts: 999, senderId: 'bob-session', traceId: 'trace-payload-free' },
            route: { topicId: 'room.manual.message', contextId: 'bb-group', resourceId: 'message-1' },
            payload: { typeId: 'room.manual.message', contentType: 'application/json', resource: JSON.stringify(secretPayload) }
        },
        receivedAtEpochMs: 1_000,
        reply: vi.fn()
    };
}
