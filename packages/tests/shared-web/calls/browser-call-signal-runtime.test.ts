import { BrowserCallSignalRuntime } from '@shared-web/browser/calls/browser-call-signal-runtime.ts';
import type { RallarMessage, RallarMessageHandler } from '@shared-web/browser/messages/rallar-message-contracts.ts';
import type { RallarMessagesOperations } from '@shared-web/browser/messages/rallar-message-operations.ts';
import type { RallarCallHandle, RallarCallSignalEvent, RallarCallSignalPayload, RallarIncomingCallInvite } from '@shared-web/browser/rallar-calls-facade.ts';
import type { RallarTargetSelector } from '@shared-web/browser/rallar-realtime-facade.ts';
import type { AuthSession } from '@shared/api/api-config.ts';
import { describe, expect, it } from 'vitest';
import { createMessageDelivery } from '../messages/test-message-delivery.ts';

interface CallSignalTestInput {
    readonly onSend?: (input: BrowserCallSignalRuntime.SignalSendInput<unknown>) => void;
    readonly resolveTargetPeerIds?: (
        input?: RallarTargetSelector
    ) => readonly string[];
    readonly onSubscribe?: (
        handler: RallarMessageHandler<unknown>
    ) => void;
}

describe('BrowserCallSignalRuntime', () => {
    it.each([
        { kind: 'other' },
        { callId: 1 },
        { fromPeerId: null },
        { toPeerIds: [1] },
        { occurredAtEpochMs: -1 },
        { occurredAtEpochMs: Infinity },
        { data: { laneIds: 'lane' } },
        { roomRef: { applicationId: 'bad app', workspaceId: 'workspace', groupId: 'room' } },
        { media: [] },
        { data: null },
        { data: {} },
        { data: { laneIds: [1] } },
        { roomRef: null },
        { roomRef: { applicationId: 'app', groupId: 'room' } },
        { membership: 'other' },
        { media: null },
        { media: { audio: 'yes' } },
        { media: { video: 1 } },
        { media: { screen: [] } },
        { message: 1 },
        { reason: false },
        { occurredAtEpochMs: NaN }
    ])('rejects malformed known signal fields %j', async (fields) => {
        let inbound: RallarMessageHandler<unknown> | undefined;
        const events: RallarCallSignalEvent[] = [];
        const runtime = createCallSignalRuntime({
            onSubscribe: (handler) => {
                inbound = handler;
            }
        }, async () => {
            throw new Error('Unexpected call start');
        });
        runtime.onSignal((event) => {
            events.push(event);
        });
        await inbound?.(toMessage({ ...toInvitePayload(), ...fields }));
        runtime.onInvite((event) => {
            events.push(event);
        });
        await inbound?.(toMessage({ ...toInvitePayload(), ...fields }));
        expect(events).toEqual([]);
    });

    it.each([{ toPeerIds: [] }, { toPeerIds: ['session-1'] }])('accepts valid optional absence for recipients %j', async ({ toPeerIds }) => {
        let inbound: RallarMessageHandler<unknown> | undefined;
        const events: RallarCallSignalEvent[] = [];
        const runtime = createCallSignalRuntime({
            onSubscribe: (handler) => {
                inbound = handler;
            }
        }, unsupportedCallOperation);
        runtime.onSignal((event) => {
            events.push(event);
        });
        const payload = { kind: 'invite', callId: 'call', fromPeerId: 'other', toPeerIds, occurredAtEpochMs: 1 };
        await inbound?.(toMessage(payload));
        expect(events).toMatchObject([{ payload }]);
    });

    it.each(['session-1', 'unaddressed'])('ignores a self or unaddressed signal from %s', async (fromPeerId) => {
        let inbound: RallarMessageHandler<unknown> | undefined;
        const events: RallarCallSignalEvent[] = [];
        const runtime = createCallSignalRuntime({
            onSubscribe: (handler) => {
                inbound = handler;
            }
        }, unsupportedCallOperation);
        runtime.onInvite((event) => {
            events.push(event);
        });
        await inbound?.(toMessage({ ...toInvitePayload(), fromPeerId, toPeerIds: ['someone-else'] }));
        expect(events).toEqual([]);
    });

    it('uses composition time and identity while excluding the sending session', async () => {
        const sent: BrowserCallSignalRuntime.SignalSendInput<unknown>[] = [];
        const runtime = createCallSignalRuntime({
            resolveTargetPeerIds: () => ['session-1', 'peer', 'peer'],
            onSend: (value) => {
                sent.push(value);
            }
        }, unsupportedCallOperation);
        const result = await runtime.invite({ peerIds: ['session-1', 'peer'], media: { audio: false, video: true } });
        expect(result.callId).toBe('generated-call');
        expect(sent).toMatchObject([{
            peerId: 'peer',
            payload: {
                fromPeerId: 'session-1',
                callId: 'generated-call',
                occurredAtEpochMs: 123,
                media: { audio: false, video: true, screen: false }
            }
        }]);
    });

    it('preserves valid optional signal data and false media flags', async () => {
        let inbound: RallarMessageHandler<unknown> | undefined;
        const events: RallarCallSignalEvent[] = [];
        const runtime = createCallSignalRuntime({
            onSubscribe: (handler) => {
                inbound = handler;
            }
        }, unsupportedCallOperation);
        runtime.onSignal((event) => {
            events.push(event);
        });
        const payload = { ...toInvitePayload(), media: { audio: false, video: false, screen: true }, message: 'hello', reason: 'reason' };
        await inbound?.(toMessage(payload));
        expect(events).toMatchObject([{ payload, media: payload.media, message: 'hello', reason: 'reason', dataLaneIds: ['reliable'] }]);
    });

    it('starts an accepted call from the signal target without inheriting room membership', async () => {
        let inbound: RallarMessageHandler<unknown> | undefined;
        const startInputs: RallarTargetSelector[] = [];
        const invites: RallarIncomingCallInvite[] = [];
        const runtime = createCallSignalRuntime({
            onSubscribe: (handler) => {
                inbound = handler;
            }
        }, async (input) => {
            startInputs.push(input);
            return createCallHandle(input.callId ?? 'missing');
        });
        runtime.onInvite((invite) => {
            invites.push(invite);
        });

        await inbound?.(toMessage(toInvitePayload()));
        await invites[0]?.accept();

        expect(startInputs).toEqual([{
            callId: 'call-1',
            peerId: 'peer-caller',
            data: { lanes: ['reliable'] }
        }]);
    });
});

function createCallSignalRuntime(
    input: CallSignalTestInput,
    startCall: BrowserCallSignalRuntime.Input['startCall']
): BrowserCallSignalRuntime {
    return new BrowserCallSignalRuntime({
        nowMs: () => 123,
        createCallId: () => 'generated-call',
        connect: async () => {},
        readSession: testSession,
        requireSession: testSession,
        resolveRoomRef: () => undefined,
        resolveTargetPeerIds: input.resolveTargetPeerIds ?? (() => ['peer-caller']),
        messages: createMessages(input),
        readSourceStatus: () => undefined,
        sendWsUnicast: async (send) => {
            input.onSend?.(send);
            return createMessageDelivery('ws', undefined).handle;
        },
        startCall
    });
}

function createMessages(input: CallSignalTestInput): RallarMessagesOperations {
    return {
        ws: {
            send: unsupportedCallOperation,
            onMessage: (_selector, handler) => {
                input.onSubscribe?.(handler as RallarMessageHandler<unknown>);
                return () => {};
            }
        },
        rtc: { send: unsupportedCallOperation, onMessage: unsupportedCallOperation },
        channel: unsupportedCallOperation,
        room: unsupportedCallOperation
    };
}

function toMessage<T>(payload: T): RallarMessage<T> {
    return {
        payload,
        transport: 'ws',
        typeId: 'app.rallar.calls.invite.v1',
        topicId: 'app.rallar.calls',
        contextId: 'call-1',
        resourceId: '',
        senderId: 'peer-caller',
        receivedAtEpochMs: 1,
        raw: {
            id: { v: 2, msgId: 'signal-1', senderId: 'peer-caller', ts: 1 },
            route: { topicId: 'app.rallar.calls', contextId: 'call-1', resourceId: '' },
            payload: { typeId: 'app.rallar.calls.invite.v1', contentType: 'application/json', resource: JSON.stringify(payload) }
        }
    };
}

function toInvitePayload(): RallarCallSignalPayload {
    return {
        kind: 'invite',
        callId: 'call-1',
        fromPeerId: 'peer-caller',
        toPeerIds: ['session-1'],
        roomRef: { applicationId: 'app-1', workspaceId: 'workspace-1', groupId: 'room-1' },
        membership: 'live',
        data: { laneIds: ['reliable'] },
        media: {},
        occurredAtEpochMs: 1
    };
}

function testSession(): AuthSession {
    return { sessionId: 'session-1', clientId: 'client-1', accessToken: 'test-token', username: 'test', expiresAtEpochMs: 60_000 };
}

function unsupportedCallOperation(): never {
    throw new Error('Operation is outside this call signal scenario');
}

function createCallHandle(id: string): RallarCallHandle {
    const source = { start: unsupportedCallOperation, status: unsupportedCallOperation, stop: unsupportedCallOperation };
    return {
        id,
        status: unsupportedCallOperation,
        wait: unsupportedCallOperation,
        channel: unsupportedCallOperation,
        setLocalStream: unsupportedCallOperation,
        setAudioEnabled: unsupportedCallOperation,
        setVideoEnabled: unsupportedCallOperation,
        stopLocal: unsupportedCallOperation,
        end: unsupportedCallOperation,
        sources: { microphone: source, camera: source, screen: source }
    };
}
