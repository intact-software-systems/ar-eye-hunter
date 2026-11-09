import { describe, expect, it, vi } from 'vitest';

import { AL_WS_SERVER_CAPABILITIES, toALCarrierQosInputProvider } from '@shared/al-contracts/al-carrier-capabilities.ts';
import { newALBroadcastMessage, newALRoute, type ALMessage } from '@shared/al-contracts/al-contract.ts';
import { parseALControlMessage } from '@shared/al-contracts/al-control.ts';
import { toALOrderingTrackKey } from '@shared/al-contracts/al-runtime.ts';
import { toALMessageTrace } from '@shared/al-contracts/trace/to-al-message-trace.ts';
import { createInMemoryALAdmissionState, InMemoryAdmissionBackend } from '@shared/alm/al-admission-backend.ts';
import { normalizeALRuntimeStoreRetention } from '@shared/alm/ALStoreRetention.ts';
import { toALOutboundSentMessageKey } from '@shared/alm/outbound/admission/al-outbound-admission-keys.ts';
import { createALOutboundAdmissionStore } from '@shared/alm/outbound/admission/al-outbound-admission-store.ts';
import { toALOutboundOrderingMessageKey } from '@shared/alm/outbound/admission/al-outbound-ordering-track-keys.ts';
import type { ALOutboundRuntimeDiagnosticsEvent } from '@shared/alm/outbound/al-outbound-message-runtime.ts';
import { toALOrderingBatchSequences } from '@shared/alm/outbound/lane/compute-al-outbound-group-sent-positions.ts';
import { WsQueueBoxServerDeliveryReporting } from '@shared/services/ws-queue-box-server/ws-queue-box-server-delivery-reporting.ts';
import {
    WsQueueBoxServerOutboundPlanning,
    type WsQueueBoxServerPreparedMessage
} from '@shared/services/ws-queue-box-server/ws-queue-box-server-outbound-planning.ts';
import { WsQueueBoxServerTargetResolution } from '@shared/services/ws-queue-box-server/ws-queue-box-server-target-resolution.ts';
import { WsQueueBoxServerTrackOrder } from '@shared/services/ws-queue-box-server/ws-queue-box-server-track-order.ts';
import { JsonWebSocketServer } from '@shared/websocket/json-web-socket-server.ts';

const NAMESPACE = 'outbound';
const NOW_MS = 1_700_000_000_000;
const LIVE_UNTIL_MS = NOW_MS + 60_000;
const ROOM = { applicationId: 'app', workspaceId: 'workspace', groupId: 'room-1' };

function trackedMessage(seq: number): ALMessage {
    const message = newALBroadcastMessage('server', newALRoute('room.round.event', ROOM.groupId, `event-${seq}`), 'room', 'round.event.v1', {}, {
        groupRef: ROOM
    });
    return { ...message, ordering: { orderingKey: 'game-1', epoch: 1, seq } };
}

const TRACK_KEY = toALOrderingTrackKey(trackedMessage(1))!;

interface TrackFixture {
    readonly backend: InMemoryAdmissionBackend;
    readonly admissionStore: ReturnType<typeof createALOutboundAdmissionStore<WsQueueBoxServerPreparedMessage>>;
    /** The logical recipient each outside-audience ACK the relay was handed names. */
    readonly outsideAcks: string[];
    readonly diagnostics: ALOutboundRuntimeDiagnosticsEvent[];
    readonly trackOrder: WsQueueBoxServerTrackOrder;
}

interface TrackFixtureOptions {
    readonly connections?: JsonWebSocketServer['connections'];
    readonly resolvePolicy?: WsQueueBoxServerOutboundPlanning['resolvePolicy'];
}

function createTrackFixture(options: TrackFixtureOptions = {}): TrackFixture {
    const backend = new InMemoryAdmissionBackend(createInMemoryALAdmissionState(), () => NOW_MS);
    const admissionStore = createALOutboundAdmissionStore<WsQueueBoxServerPreparedMessage>({
        nowMs: () => NOW_MS,
        canonicalScope: 'scope',
        namespace: NAMESPACE,
        backend,
        supersedenceTrackTtlMs: 60_000,
        retention: normalizeALRuntimeStoreRetention(),
        decodePrepared: () => {
            throw new TypeError('The track order reads no prepared message');
        }
    });
    const outsideAcks: string[] = [];
    const writeServerAck = async (ack: ALMessage) => {
        const control = parseALControlMessage(ack);
        outsideAcks.push(control?.type === 'ack' ? control.payload.logicalRecipientPeerId ?? '' : '');
    };
    const diagnostics: ALOutboundRuntimeDiagnosticsEvent[] = [];
    const trackOrder = new WsQueueBoxServerTrackOrder({
        admissionStore,
        clock: { nowMs: () => NOW_MS },
        socket: { connections: options.connections ?? new Map() },
        ackRelay: { writeServerAck },
        outboundPlanning: {
            resolvePolicy: options.resolvePolicy ?? (() => {
                throw new TypeError('The wait resolves no policy');
            })
        },
        name: 'server',
        newControlId: () => 'control',
        diagnostics: (event) => diagnostics.push(event)
    });
    return { backend, admissionStore, outsideAcks, diagnostics, trackOrder };
}

/** Index rows for each sequence, and a stored row recorded (`{ b: seq - 1 }`) or unrecorded (`null`) where named. */
async function writeTrack(
    fixture: TrackFixture,
    seqs: readonly number[],
    storedPositions: ReadonlyMap<number, Readonly<Record<string, number>> | null>
): Promise<void> {
    await fixture.backend.write(async (tx) => {
        for (const seq of seqs) {
            await tx.set(toALOutboundOrderingMessageKey(NAMESPACE, TRACK_KEY, seq), `event-${seq}`, LIVE_UNTIL_MS);
        }
        for (const [seq, sentPositions] of storedPositions) {
            await tx.set(toALOutboundSentMessageKey(NAMESPACE, `event-${seq}`), storedRowValue(seq, sentPositions), LIVE_UNTIL_MS);
        }
    });
}

function storedRowValue(seq: number, sentPositions: Readonly<Record<string, number>> | null) {
    const msgId = `event-${seq}`;
    return {
        msgId,
        reference: {
            key: { topicId: 'AL_OUTBOUND_MESSAGE', resourceId: 'scope', contextId: msgId },
            typeId: 'AL_OUTBOUND_MESSAGE',
            scope: 'scope',
            msgId,
            senderId: 'server',
            identity: msgId,
            expiresAtMs: LIVE_UNTIL_MS
        },
        unicastPeerId: null,
        orderingTrackKey: TRACK_KEY,
        orderingSeq: seq,
        sentPositions,
        policy: { persist: true, ackTracking: null, retryTracking: null, repairTracking: null, supersedenceTracking: null, admittedAudience: ['b'] },
        creationExpiry: 'creation-expiry'
    };
}

function toStoredReadKeys(keys: readonly string[]): readonly string[] {
    const sentPrefix = toALOutboundSentMessageKey(NAMESPACE, '');
    return keys.filter((key) => key.startsWith(sentPrefix));
}

describe('the WS track order of a dequeued row', () => {
    it('stops at a settled predecessor: the absent sequences below it are neither read nor pending', async () => {
        const fixture = createTrackFixture();
        await writeTrack(fixture, [1, 2, 3, 4, 5], new Map([[5, { b: 4 }]]));
        const message = trackedMessage(6);
        const read = vi.spyOn(fixture.backend, 'read');

        const authority = await fixture.trackOrder.readTrackOrderAuthority(message, new Map());

        expect(authority).toEqual({ status: 'authorized' });
        expect(toStoredReadKeys(read.mock.calls.map(([key]) => key))).toEqual(
            [message.id.msgId, 'event-5'].map((msgId) => toALOutboundSentMessageKey(NAMESPACE, msgId))
        );
    });

    it('follows only the unrecorded sequence above the settled one', async () => {
        const fixture = createTrackFixture();
        await writeTrack(fixture, [1, 2, 3, 4, 5, 6], new Map([[5, { b: 4 }], [6, null]]));
        const batch = toALOrderingBatchSequences([trackedMessage(6), trackedMessage(8)]);

        const authority = await fixture.trackOrder.readTrackOrderAuthority(trackedMessage(8), batch);

        expect(authority).toEqual({ status: 'follows-batch-predecessor', seqs: [6] });
    });

    it('waits for the nearest absent sequence when no listed sequence has settled', async () => {
        const fixture = createTrackFixture();
        await writeTrack(fixture, [1, 2, 3], new Map([[3, null]]));
        const batch = toALOrderingBatchSequences([trackedMessage(3), trackedMessage(4)]);

        const authority = await fixture.trackOrder.readTrackOrderAuthority(trackedMessage(4), batch);

        expect(authority).toMatchObject({ status: 'held', reason: 'WS row waits for sequence 2 of its track to record first' });
    });
});

const PLANNING = new WsQueueBoxServerOutboundPlanning({
    serverPeerId: 'server',
    qosProvider: toALCarrierQosInputProvider(AL_WS_SERVER_CAPABILITIES, undefined),
    targetResolution: new WsQueueBoxServerTargetResolution({
        socket: new JsonWebSocketServer(),
        targetResolver: { requiresFrozenAudience: () => false }
    }),
    deliveryReporting: new WsQueueBoxServerDeliveryReporting({})
});
const resolveReceiverPolicy: WsQueueBoxServerOutboundPlanning['resolvePolicy'] = (message) => PLANNING.resolvePolicy(message);

/** A receiver-acked row, so its receipt counts logical recipients the writer can record outside. */
function rowFrom(senderId: string): ALMessage {
    const message = trackedMessage(2);
    return { ...message, id: { ...message.id, senderId }, qos: { ...message.qos, ack: { algo: 'receiver' } } };
}

interface OwnOutsideCommit {
    readonly receipt: { readonly originPeerId: string; readonly msgId: string; };
    readonly sessionIds: readonly string[];
}

describe('the WS outside-audience writer', () => {
    it('records a durable drop outside with no socket open here', async () => {
        const fixture = createTrackFixture({ resolvePolicy: resolveReceiverPolicy });
        const ownCommits: OwnOutsideCommit[] = [];
        vi.spyOn(fixture.admissionStore, 'commitOutsideAudience').mockImplementation(async (receipt, sessionIds) => {
            ownCommits.push({ receipt, sessionIds });
            return 'absent';
        });
        const own = rowFrom('server');

        await fixture.trackOrder.writeOutsideAudience(rowFrom('origin'), ['b'], 'durable');
        await fixture.trackOrder.writeOutsideAudience(own, ['b'], 'durable');

        expect(fixture.outsideAcks).toEqual(['b']);
        expect(ownCommits).toEqual([{ receipt: { originPeerId: 'server', msgId: own.id.msgId }, sessionIds: ['b'] }]);
    });

    it('judges an open-here drop only for a session whose socket here is open', async () => {
        const connections = new Map() as JsonWebSocketServer['connections'];
        const fixture = createTrackFixture({ connections, resolvePolicy: resolveReceiverPolicy });

        await fixture.trackOrder.writeOutsideAudience(rowFrom('origin'), ['b'], 'open-here');
        expect(fixture.outsideAcks).toEqual([]);

        connections.set('b', { isOpen: true } as never);
        await fixture.trackOrder.writeOutsideAudience(rowFrom('origin'), ['b'], 'open-here');
        expect(fixture.outsideAcks).toEqual(['b']);
    });

    it('after three conflicts writes one outside-audience-commit diagnostic and no console line', async () => {
        const fixture = createTrackFixture({ resolvePolicy: resolveReceiverPolicy });
        const attempts: string[] = [];
        vi.spyOn(fixture.admissionStore, 'commitOutsideAudience').mockImplementation(async (receipt) => {
            attempts.push(receipt.msgId);
            return 'conflict';
        });
        const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
        const own = rowFrom('server');

        await fixture.trackOrder.writeOutsideAudience(own, ['b'], 'durable');

        expect(attempts).toEqual([own.id.msgId, own.id.msgId, own.id.msgId]);
        expect(fixture.diagnostics).toEqual([{
            kind: 'outside-audience-commit',
            msgId: own.id.msgId,
            recipientPeerIds: ['b'],
            attempts: 3,
            outcome: 'conflict',
            ...toALMessageTrace(own)
        }]);
        expect(error.mock.calls).toEqual([]);
        error.mockRestore();
    });

    it('stops at the first committed attempt and writes no diagnostic', async () => {
        const fixture = createTrackFixture({ resolvePolicy: resolveReceiverPolicy });
        const answers = ['conflict', 'committed'] as const;
        const attempts: string[] = [];
        vi.spyOn(fixture.admissionStore, 'commitOutsideAudience').mockImplementation(async () => {
            attempts.push(answers[attempts.length]!);
            return answers[attempts.length - 1]!;
        });

        await fixture.trackOrder.writeOutsideAudience(rowFrom('server'), ['b'], 'durable');

        expect(attempts).toEqual(['conflict', 'committed']);
        expect(fixture.diagnostics).toEqual([]);
    });
});
