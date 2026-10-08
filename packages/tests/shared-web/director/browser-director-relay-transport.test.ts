import { BrowserDirectorRelayTransport } from '@shared-web/browser/director/browser-director-relay-transport.ts';
import type { RallarDirectorRelayEnvelope, RallarDirectorStatus } from '@shared-web/browser/director/rallar-director-facade.ts';
import type {
    RallarRoomMessageChannelDefinition,
    RallarTypedMessageChannel
} from '@shared-web/browser/messages/rallar-message-contracts.ts';
import type { RallarMessagesOperations } from '@shared-web/browser/messages/rallar-message-operations.ts';
import type { GroupSnapshot } from '@shared/api/group-types.ts';
import { RallarValidationError } from '@shared/api/rallar-validation.ts';
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import {
    createOriginPrincipalSnapshot,
    createRtcOriginOverlayFixture,
    ORIGIN_ROOM
} from '../../shared/multicast/rtc-origin-overlay-fixture.ts';
import { createDefaultApiMiddlewareTestDouble } from '../api-middleware-test-double.ts';
import { createGroupSnapshotFixture } from '../authoritative-group-fixtures.ts';
import {
    createRallarTestFacade,
    getRallarFacadeMocks,
    resetRallarFacadeTestRuntime,
    setRallarFacadeRoomSnapshots
} from '../messages/rallar-facade-test-runtime.ts';
import { createMessageDelivery, type MessageDeliveryFixture } from '../messages/test-message-delivery.ts';

const mocks = getRallarFacadeMocks();

const current: RallarDirectorStatus = {
    roomRef: { applicationId: 'app', workspaceId: 'workspace', groupId: 'room' },
    roomId: 'room',
    role: 'director',
    state: 'fresh',
    isDirector: true,
    isFresh: true,
    active: true,
    freshness: 'fresh',
    nowEpochMs: 0,
    appointment: { version: 1, mode: 'appointed-spa', sessionId: 'director', principalId: 'principal', epoch: 1, appointedAtEpochMs: 0, heartbeatTtlMs: 5_000 }
};
const envelopeInput = { current, topicId: 'room.director', typeId: 'output', payload: { revision: 1 }, ack: undefined };
const clientStatus: RallarDirectorStatus = { ...current, role: 'client', isDirector: false };
const commandInput = {
    current: clientStatus,
    topicId: 'room.director',
    typeId: 'room.director.intent.v1',
    payload: { revision: 7 },
    claim: undefined
};

describe('director delivery admission', () => {
    afterEach(() => vi.useRealTimers());

    it.each(['queued', 'superseded'] as const)('waits for RTC then treats %s as sent without stale WS fallback', async (state) => {
        const rtc = createMessageDelivery('rtc', undefined);
        const ws = vi.fn(async () => createMessageDelivery('ws', { kind: 'admitted', durable: true, queuedAttempts: 1 }).handle);
        const transport = createTransport(rtc, ws);
        let completed = false;
        const sending = transport.sendRoomEnvelope(envelopeInput).then((result) => {
            completed = true;
            return result;
        });
        await Promise.resolve();
        await Promise.resolve();
        expect(completed).toBe(false);
        expect(ws).not.toHaveBeenCalled();
        rtc.registry.record({
            kind: 'admission',
            carrier: 'rtc',
            msgId: rtc.handle.msgId,
            atMs: Date.now(),
            verdict: state === 'queued' ? { kind: 'admitted', durable: true, queuedAttempts: 1 } : { kind: 'superseded', detail: 'Newer state' },
            trackedReceiptAlgo: rtc.handle.lifecycle().receiptAlgo
        });
        expect(await sending).toEqual({ status: 'sent', rtc: rtc.handle });
        expect(ws).not.toHaveBeenCalled();
    });

    it('falls back after failed RTC and reports WS refusal reason', async () => {
        const rtc = createMessageDelivery('rtc', { kind: 'failed', detail: 'RTC failed' });
        const ws = createMessageDelivery('ws', { kind: 'refused', reason: 'unauthorized', detail: 'Room denied' });
        expect(await createTransport(rtc, async () => ws.handle).sendRoomEnvelope(envelopeInput)).toEqual({
            status: 'failed',
            rtc: rtc.handle,
            ws: ws.handle,
            reason: 'Room denied'
        });
    });

    it('bounds RTC admission at the existing budget and releases its wait before fallback', async () => {
        vi.useFakeTimers();
        const rtc = createMessageDelivery('rtc', undefined);
        const ws = createMessageDelivery('ws', { kind: 'admitted', durable: true, queuedAttempts: 1 });
        const sending = createTransport(rtc, async () => ws.handle).sendRoomEnvelope(envelopeInput);
        await vi.advanceTimersByTimeAsync(5_000);
        expect(await sending).toEqual({ status: 'sent', rtc: rtc.handle, ws: ws.handle });
        expect(vi.getTimerCount()).toBe(0);
    });
});

describe('director receipt output', () => {
    const receiptInput = { ...envelopeInput, ack: 'all-logical-recipients' } as const;

    it('sends one room message over the RTC-with-WS-fallback strategy and returns its handle as the receipt', async () => {
        const receipt = createMessageDelivery('rtc', { kind: 'admitted', durable: true, queuedAttempts: 1 });
        const room = createRoomChannel(async () => receipt.handle);
        const transport = createTransport(createMessageDelivery('rtc', undefined), rejectCarrierSend, {
            room: toRoomOperation(room),
            rtcSend: rejectCarrierSend
        });

        expect(await transport.sendRoomEnvelope(receiptInput)).toEqual({ status: 'sent', receipt: receipt.handle });
        expect(room.open).toHaveBeenCalledWith({
            topicId: 'room.director',
            typeId: 'output',
            roomRef: current.roomRef,
            purpose: 'notification'
        });
        expect(room.send).toHaveBeenCalledWith(
            expect.objectContaining({ protocol: 'rallar.director.relay.v1', typeId: 'output', payload: { revision: 1 } }),
            { strategy: 'rtc-with-ws-fallback', reliability: 'at-least-once', ack: 'all-logical-recipients', ttlMs: 30_000 }
        );
    });

    it('reports a refused receipt output with its reason and no second carrier send', async () => {
        const receipt = createMessageDelivery('ws', { kind: 'refused', reason: 'unauthorized', detail: 'Room denied' });
        const room = createRoomChannel(async () => receipt.handle);
        const transport = createTransport(createMessageDelivery('rtc', undefined), rejectCarrierSend, {
            room: toRoomOperation(room),
            rtcSend: rejectCarrierSend
        });

        expect(await transport.sendRoomEnvelope(receiptInput)).toEqual({ status: 'failed', receipt: receipt.handle, reason: 'Room denied' });
    });

    it('keeps a best-effort output on the two-send path without a room channel', async () => {
        const rtc = createMessageDelivery('rtc', { kind: 'admitted', durable: true, queuedAttempts: 1 });
        const rtcSend = vi.fn(async () => rtc.handle);
        const transport = createTransport(rtc, rejectCarrierSend, {
            room: () => {
                throw new Error('A best-effort output must not use the receipt channel.');
            },
            rtcSend
        });

        expect(await transport.sendRoomEnvelope(envelopeInput)).toEqual({ status: 'sent', rtc: rtc.handle });
        expect(rtcSend).toHaveBeenCalledWith(expect.objectContaining({ reliability: 'best-effort', ack: 'none', ttlMs: 5_000 }));
    });
});

describe('director command', () => {
    afterEach(() => vi.useRealTimers());

    it.each(['room.director.intent.v1', 'room.director.sync-request.v1'])(
        'sends %s on its own command channel to the room\'s leader and reports sent on the leader\'s receipt',
        async (typeId) => {
            const command = createMessageDelivery('rtc', {
                kind: 'admitted',
                durable: false,
                queuedAttempts: 1
            }, 'group-leader');
            const sentEnvelopes: RallarDirectorRelayEnvelope<OutputPayload>[] = [];
            const room = createRoomChannel(async (envelope) => {
                sentEnvelopes.push(envelope);
                return command.handle;
            });
            const transport = createTransport(
                createMessageDelivery('rtc', undefined),
                rejectCarrierSend,
                {
                    room: toRoomOperation(room),
                    rtcSend: rejectCarrierSend
                }
            );

            const sending = transport.sendCommand({ ...commandInput, typeId });
            await vi.waitFor(() => expect(sentEnvelopes).toHaveLength(1));
            recordDirectorReceipt(command);

            expect(await sending).toEqual({ status: 'sent', receipt: command.handle });
            expect(room.open).toHaveBeenCalledWith({
                topicId: 'room.director',
                typeId,
                roomRef: current.roomRef,
                purpose: 'command'
            });
            expect(room.send).toHaveBeenCalledWith(
                expect.objectContaining({
                    protocol: 'rallar.director.relay.v1',
                    typeId,
                    roomId: 'room',
                    epoch: 1,
                    payload: { revision: 7 }
                }),
                { ack: 'group-leader', strategy: 'rtc-with-ws-fallback' }
            );
        }
    );

    it.each(['rtc', 'ws'] as const)(
        'reports a command refused for no leader on %s as no-director, with its receipt and reason',
        async (carrier) => {
            const command = toNoLeaderCommand(carrier);
            const transport = createTransport(
                createMessageDelivery('rtc', undefined),
                rejectCarrierSend,
                {
                    room: toRoomOperation(createRoomChannel(async () => command.handle)),
                    rtcSend: rejectCarrierSend
                }
            );

            expect(await transport.sendCommand(commandInput)).toEqual({
                status: 'no-director',
                receipt: command.handle,
                reason: command.handle.lifecycle().evidence.reason
            });
            expect(command.handle.lifecycle().state).toBe('rejected');
        }
    );

    it('sends an intent that claims its resource as an exclusive command to the room\'s leader', async () => {
        const command = createMessageDelivery('ws', { kind: 'admitted', durable: false, queuedAttempts: 1 }, 'group-leader');
        const sentEnvelopes: RallarDirectorRelayEnvelope<OutputPayload>[] = [];
        const room = createRoomChannel(async (envelope) => {
            sentEnvelopes.push(envelope);
            return command.handle;
        });
        const transport = createTransport(
            createMessageDelivery('rtc', undefined),
            rejectCarrierSend,
            { room: toRoomOperation(room), rtcSend: rejectCarrierSend }
        );

        const sending = transport.sendCommand({ ...commandInput, claim: { resourceId: 'pickup-1', ttlMs: 4_000 } });
        await vi.waitFor(() => expect(sentEnvelopes).toHaveLength(1));
        recordDirectorReceipt(command);

        expect(await sending).toEqual({ status: 'sent', receipt: command.handle });
        expect(room.send).toHaveBeenCalledWith(
            expect.objectContaining({ typeId: 'room.director.intent.v1', payload: { revision: 7 } }),
            {
                ack: 'group-leader',
                strategy: 'rtc-with-ws-fallback',
                ownership: 'exclusive',
                resourceId: 'pickup-1',
                ttlMs: 4_000
            }
        );
    });

    it('reports an intent whose resource another session holds as held-by-other, with its receipt and reason', async () => {
        const command = createMessageDelivery('ws', { kind: 'admitted', durable: false, queuedAttempts: 1 }, 'group-leader');
        command.registry.record({
            kind: 'relay-rejected',
            msgId: command.handle.msgId,
            carrier: 'ws',
            atMs: Date.now(),
            relayRejection: { relay: 'trusted-server', reason: 'held-by-other' },
            detail: 'The server relay refused the message: held-by-other.'
        });
        const transport = createTransport(
            createMessageDelivery('rtc', undefined),
            rejectCarrierSend,
            { room: toRoomOperation(createRoomChannel(async () => command.handle)), rtcSend: rejectCarrierSend }
        );

        expect(await transport.sendCommand({ ...commandInput, claim: { resourceId: 'pickup-1', ttlMs: 4_000 } })).toEqual({
            status: 'held-by-other',
            receipt: command.handle,
            reason: 'The server relay refused the message: held-by-other.'
        });
        expect(command.handle.lifecycle().state).toBe('rejected');
    });

    it('reports a refused command as failed with its typed refusal, never as sent (correction 11)', async () => {
        const command = createMessageDelivery('ws', {
            kind: 'refused',
            reason: 'unsupported',
            detail: 'Server unknown'
        }, 'receiver');
        const transport = createTransport(
            createMessageDelivery('rtc', undefined),
            rejectCarrierSend,
            {
                room: toRoomOperation(createRoomChannel(async () => command.handle)),
                rtcSend: rejectCarrierSend
            }
        );

        expect(await transport.sendCommand(commandInput)).toEqual({
            status: 'failed',
            receipt: command.handle,
            reason: 'Server unknown'
        });
        expect(command.handle.lifecycle().evidence.failure).toEqual({
            kind: 'refused',
            reason: 'unsupported'
        });
    });

    it('reports a command the typed send refuses before admission as failed with the refusal, not a throw', async () => {
        const refusal = new RallarValidationError('A peer-addressed send needs a server that names its peer id.', [{
            path: '$.peerId',
            code: 'unsupported',
            message: 'A peer-addressed send needs a server that names its peer id.'
        }]);
        const transport = createTransport(
            createMessageDelivery('rtc', undefined),
            rejectCarrierSend,
            {
                room: toRoomOperation(createRoomChannel(async () => {
                    throw refusal;
                })),
                rtcSend: rejectCarrierSend
            }
        );

        expect(await transport.sendCommand(commandInput)).toEqual({
            status: 'failed',
            reason: refusal.message
        });
    });

    it('keeps an unexpected send error a thrown error', async () => {
        const transport = createTransport(
            createMessageDelivery('rtc', undefined),
            rejectCarrierSend,
            {
                room: toRoomOperation(createRoomChannel(async () => {
                    throw new Error('Storage unavailable');
                })),
                rtcSend: rejectCarrierSend
            }
        );

        await expect(transport.sendCommand(commandInput)).rejects.toThrow('Storage unavailable');
    });

    it('reports an admitted command the director never confirms as failed at its deadline', async () => {
        vi.useFakeTimers();
        const command = createMessageDelivery('rtc', {
            kind: 'admitted',
            durable: false,
            queuedAttempts: 1
        }, 'receiver');
        const transport = createTransport(
            createMessageDelivery('rtc', undefined),
            rejectCarrierSend,
            {
                room: toRoomOperation(createRoomChannel(async () => command.handle)),
                rtcSend: rejectCarrierSend
            }
        );

        const sending = transport.sendCommand(commandInput);
        await vi.advanceTimersByTimeAsync(30_000);

        expect(await sending).toEqual({
            status: 'failed',
            receipt: command.handle,
            reason: 'The director did not confirm the command before its deadline.'
        });
        expect(vi.getTimerCount()).toBe(0);
    });

    it('reports a claiming intent the director never confirms as failed once the claim\'s own lifetime ends', async () => {
        vi.useFakeTimers();
        const command = createMessageDelivery('ws', { kind: 'admitted', durable: false, queuedAttempts: 1 }, 'group-leader');
        const transport = createTransport(
            createMessageDelivery('rtc', undefined),
            rejectCarrierSend,
            { room: toRoomOperation(createRoomChannel(async () => command.handle)), rtcSend: rejectCarrierSend }
        );
        let settled = false;

        const sending = transport.sendCommand({ ...commandInput, claim: { resourceId: 'pickup-1', ttlMs: 4_000 } })
            .then((result) => {
                settled = true;
                return result;
            });
        await vi.advanceTimersByTimeAsync(3_999);
        expect(settled).toBe(false);
        await vi.advanceTimersByTimeAsync(1);

        expect(await sending).toEqual({
            status: 'failed',
            receipt: command.handle,
            reason: 'The director did not confirm the command before its deadline.'
        });
        expect(vi.getTimerCount()).toBe(0);
    });

    it.each(
        [
            { current: { ...clientStatus, isFresh: false }, status: 'stale-director' },
            { current, status: 'not-director' },
            { current: { ...clientStatus, roomRef: undefined }, status: 'no-director' }
        ] as const
    )(
        'refuses a command to a $status target without opening a channel',
        async ({ current: target, status }) => {
            const transport = createTransport(
                createMessageDelivery('rtc', undefined),
                rejectCarrierSend,
                {
                    room: () => {
                        throw new Error('A refused command must not open a channel.');
                    },
                    rtcSend: rejectCarrierSend
                }
            );

            expect(await transport.sendCommand({ ...commandInput, current: target })).toMatchObject(
                { status }
            );
        }
    );
});

describe('director notification fence', () => {
    beforeEach(() => resetRallarFacadeTestRuntime());

    it('stamps the snapshot and the roster of the director\'s cached room snapshot on a receipted room output', async () => {
        setRallarFacadeRoomSnapshots([toDirectorRoomSnapshot({ snapshotVersion: 9, rosterVersion: 4 })]);
        const facade = createRallarTestFacade();
        const transport = new BrowserDirectorRelayTransport({ messages: facade.messages, readSession: () => mocks.apiMiddleware.session });

        await transport.sendRoomEnvelope({ ...envelopeInput, ack: 'all-logical-recipients' });

        expect(vi.mocked(mocks.apiMiddleware.middleware.rtcRxStreamer).enqueueOutboxIfAbsent.mock.calls[0][0].targets).toMatchObject({
            mode: 'multicast',
            groupRef: current.roomRef,
            minSnapshotVersion: 9,
            rosterVersion: 4
        });
    });
});

describe('director command over a real RTC origin', () => {
    beforeEach(() => resetRallarFacadeTestRuntime());

    it('reports the command the RTC origin refuses for a room with no leader as no-director', async () => {
        const snapshot = createOriginPrincipalSnapshot();
        const origin = createRtcOriginOverlayFixture({ snapshot, nextHopPeerIds: ['b', 'c'] });
        mocks.apiMiddleware = createDefaultApiMiddlewareTestDouble({
            session: { sessionId: 'a' },
            middleware: { rtcRxStreamer: { enqueueOutboxIfAbsent: (message) => origin.manager.enqueueIfAbsent(message) } }
        });
        setRallarFacadeRoomSnapshots([snapshot]);
        const transport = new BrowserDirectorRelayTransport({
            messages: createRallarTestFacade().messages,
            readSession: () => mocks.apiMiddleware.session
        });

        const result = await transport.sendCommand({ ...commandInput, current: { ...clientStatus, roomRef: ORIGIN_ROOM } });

        expect(result).toMatchObject({
            status: 'no-director',
            reason: 'no-leader: the room has no active leader inside the audience the send names'
        });
        expect(result.receipt?.lifecycle().evidence.failure).toEqual({ kind: 'refused', reason: 'no-leader' });
        expect(result.receipt?.lifecycle().evidence.carrierFallback).toBeUndefined();
    });
});

/** The director's room as its cache holds it: the director's own session and one recipient, at the given versions. */
function toDirectorRoomSnapshot(versions: Readonly<{ snapshotVersion: number; rosterVersion: number; }>): GroupSnapshot {
    const snapshot = createGroupSnapshotFixture({
        applicationId: 'app',
        workspaceId: 'workspace',
        groupId: 'room',
        sessionIds: [mocks.apiMiddleware.session.sessionId, 'peer-1']
    });
    return { ...snapshot, group: { ...snapshot.group, ...versions } };
}

/** The RTC origin refuses the command at its admission; the server refuses it at WS ingress, after the client admitted it. */
function toNoLeaderCommand(carrier: 'rtc' | 'ws'): MessageDeliveryFixture {
    if (carrier === 'rtc') {
        return createMessageDelivery('rtc', {
            kind: 'refused',
            reason: 'no-leader',
            detail: 'no-leader: the room has no active leader inside the audience the send names'
        }, 'group-leader');
    }
    const command = createMessageDelivery('ws', { kind: 'admitted', durable: false, queuedAttempts: 1 }, 'group-leader');
    command.registry.record({
        kind: 'relay-rejected',
        msgId: command.handle.msgId,
        carrier: 'ws',
        atMs: Date.now(),
        relayRejection: { relay: 'trusted-server', reason: 'no-leader' },
        detail: 'The server relay refused the message: no-leader.'
    });
    return command;
}

function recordDirectorReceipt(command: MessageDeliveryFixture): void {
    command.registry.record({
        kind: 'acknowledgement',
        carrier: 'rtc',
        msgId: command.handle.msgId,
        atMs: Date.now(),
        mode: 'leader',
        confirmedHopPeerIds: [],
        unconfirmedHopPeerIds: [],
        expectedRecipientPeerIds: ['director'],
        confirmedRecipientPeerIds: ['director'],
        unconfirmedRecipientPeerIds: [],
        complete: true
    });
}

async function rejectCarrierSend(): Promise<never> {
    throw new Error('This output must not reach a carrier-pinned send.');
}

interface OutputPayload {
    readonly revision: number;
}

interface RoomChannelDouble {
    readonly open: Mock<(definition: RallarRoomMessageChannelDefinition) => RallarTypedMessageChannel<RallarDirectorRelayEnvelope<OutputPayload>>>;
    readonly send: Mock<RallarTypedMessageChannel<RallarDirectorRelayEnvelope<OutputPayload>>['send']>;
}

function createRoomChannel(send: RallarTypedMessageChannel<RallarDirectorRelayEnvelope<OutputPayload>>['send']): RoomChannelDouble {
    const sendDouble = vi.fn<RallarTypedMessageChannel<RallarDirectorRelayEnvelope<OutputPayload>>['send']>(send);
    const channel: RallarTypedMessageChannel<RallarDirectorRelayEnvelope<OutputPayload>> = {
        send: sendDouble,
        sendRtc: rejectCarrierSend,
        sendWs: rejectCarrierSend,
        onRtc: () => () => {},
        onWs: () => () => {}
    };
    const open = vi.fn((_definition: RallarRoomMessageChannelDefinition) => channel);
    return { open, send: sendDouble };
}

function toRoomOperation(room: RoomChannelDouble): RallarMessagesOperations['room'] {
    return <T>(definition: RallarRoomMessageChannelDefinition) => room.open(definition) as RallarTypedMessageChannel<T>;
}

interface TransportChannels {
    readonly room: RallarMessagesOperations['room'];
    readonly rtcSend: RallarMessagesOperations['rtc']['send'];
}

function createTransport(
    rtc: MessageDeliveryFixture,
    sendWs: RallarMessagesOperations['ws']['send'],
    channels?: TransportChannels
): BrowserDirectorRelayTransport {
    return new BrowserDirectorRelayTransport({
        messages: {
            rtc: { send: channels?.rtcSend ?? (async () => rtc.handle), onMessage: () => () => {} },
            ws: { send: sendWs, onMessage: () => () => {} },
            channel: () => {
                throw new Error('Not a typed channel test');
            },
            room: channels?.room ?? (() => {
                throw new Error('Not a room test');
            })
        },
        readSession: () => ({ clientId: 'client', sessionId: 'session', username: 'user', accessToken: 'test', expiresAtEpochMs: 60_000 })
    });
}
