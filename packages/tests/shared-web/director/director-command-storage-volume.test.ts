import 'fake-indexeddb/auto';
import { BrowserDirectorRelayTransport } from '@shared-web/browser/director/browser-director-relay-transport.ts';
import type { RallarDirectorStatus } from '@shared-web/browser/director/rallar-director-facade.ts';
import { BrowserChannelRecoveryOwners } from '@shared-web/browser/messages/browser-channel-recovery-owners.ts';
import { BrowserMessageInputValidator } from '@shared-web/browser/messages/browser-message-input-validator.ts';
import type { BrowserRallarMessageSender } from '@shared-web/browser/messages/browser-rallar-message-sender.ts';
import { BrowserTypedMessageChannels } from '@shared-web/browser/messages/browser-typed-message-channels.ts';
import type {
    RallarRoomMessageChannelDefinition,
    RallarTypedMessageChannelDefinition
} from '@shared-web/browser/messages/rallar-message-contracts.ts';
import type { ALMessage } from '@shared/al-contracts/al-contract.ts';
import { resolveALOutboundStoreDurability } from '@shared/al-contracts/al-policy.ts';
import { normalizeALQosPolicy } from '@shared/al-contracts/normalize-al-qos-policy.ts';
import { createVolatileALOutboundRuntimeStores } from '@shared/alm/al-runtime-stores.ts';
import {
    createCountingIndexedDbOperationObserver,
    type IndexedDbOperationCounts
} from '@shared/persistence/indexed-db-operation-observer.ts';
import { describe, expect, it, vi } from 'vitest';

import {
    createDefaultOutboundTestRuntime,
    createIndexedDbOutboundTestStores
} from '../../shared/alm/outbound-runtime-test-fixture.ts';
import { decodeOutboundTestPayload } from '../../shared/alm/outbound-test-payload.ts';
import { createBrowserMessageSenderFixture } from '../messages/browser-message-sender-fixture.ts';

const ROOM_REF = { applicationId: 'app', workspaceId: 'workspace', groupId: 'room' };

const CLIENT_STATUS: RallarDirectorStatus = {
    roomRef: ROOM_REF,
    roomId: 'room',
    role: 'client',
    state: 'fresh',
    isDirector: false,
    isFresh: true,
    active: true,
    freshness: 'fresh',
    nowEpochMs: 0,
    appointment: {
        version: 1,
        mode: 'appointed-spa',
        sessionId: 'director',
        principalId: 'principal',
        epoch: 1,
        appointedAtEpochMs: 0,
        heartbeatTtlMs: 5_000
    }
};

describe('director command browser storage volume (D60, D87)', () => {
    it('sends a director intent through the real sender in 0 al-admission and 0 non-probe al-work operations', async () => {
        const observer = createCountingIndexedDbOperationObserver();
        const sent: string[] = [];
        const runtime = createDefaultOutboundTestRuntime({
            stores: createIndexedDbOutboundTestStores({ observer, namespace: 'director-command-volume' }),
            volatileStores: createVolatileALOutboundRuntimeStores(
                { decodePrepared: decodeOutboundTestPayload },
                undefined
            ),
            carrier: 'rtc',
            planOutgoingMessage: (msg) => ({
                msg,
                dropReasonCode: undefined,
                lane: resolveALOutboundStoreDurability(normalizeALQosPolicy(msg).effective.durability.algo),
                preparedMessages: [{ kind: 'send' }]
            }),
            sendPreparedMessage: async () => {
                sent.push('send');
                return { status: 'sent' as const, submissionAttempted: true };
            }
        });
        await runtime.ready();
        observer.reset();
        const fixture = createBrowserMessageSenderFixture();
        const admitted: ALMessage[] = [];
        fixture.middleware.middleware.rtcRxStreamer.enqueueOutboxIfAbsent = async (message) => {
            admitted.push(message);
            return await runtime.enqueueIfAbsent(message);
        };

        const sending = createCommandTransport(fixture.sender).sendCommand({
            current: CLIENT_STATUS,
            topicId: 'room.director',
            typeId: 'room.director.intent.v1',
            payload: { kind: 'pickup-intent' },
            claim: undefined
        });
        await vi.waitFor(() => expect(sent.length).toBeGreaterThan(0));
        const counts = observer.getCounts();
        recordDirectorReceipt(fixture.registry, admitted[0]);

        expect(admitted).toHaveLength(1);
        expect(admitted[0]).toMatchObject({
            targets: { mode: 'multicast', groupRef: ROOM_REF },
            delivery: { reliability: 'at-least-once', ack: 'group-leader' },
            qos: { durability: { algo: 'volatile' } }
        });
        expect(counts.byOwner['al-admission'], 'a director command commits nothing to IndexedDB')
            .toBe(0);
        expect(computeNonProbeWorkOperations(counts), 'no non-probe al-work operation').toBe(0);
        expect(await sending).toMatchObject({ status: 'sent' });
        runtime.dispose();
    });
});

function createCommandTransport(sender: BrowserRallarMessageSender): BrowserDirectorRelayTransport {
    const channels = new BrowserTypedMessageChannels({
        inputValidator: new BrowserMessageInputValidator({ readMaxPayloadBytes: () => 64 * 1024 }),
        sender,
        rtc: { onMessage: () => () => {} },
        ws: { onMessage: () => () => {} },
        recoveryOwners: new BrowserChannelRecoveryOwners()
    });
    return new BrowserDirectorRelayTransport({
        messages: {
            rtc: { send: rejectLaneSend, onMessage: () => () => {} },
            ws: { send: rejectLaneSend, onMessage: () => () => {} },
            channel: <T>(definition: RallarTypedMessageChannelDefinition) => channels.channel<T>(definition),
            room: <T>(definition: RallarRoomMessageChannelDefinition) => channels.room<T>(definition)
        },
        readSession: () => ({
            clientId: 'client',
            sessionId: 'session',
            username: 'user',
            accessToken: 'test',
            expiresAtEpochMs: 60_000
        })
    });
}

async function rejectLaneSend(): Promise<never> {
    throw new Error('A director command travels its typed command channel, never a lane send.');
}

function recordDirectorReceipt(
    registry: ReturnType<typeof createBrowserMessageSenderFixture>['registry'],
    message: ALMessage | undefined
): void {
    if (!message) {
        throw new Error('The director command reached no carrier.');
    }
    registry.record({
        kind: 'acknowledgement',
        carrier: 'rtc',
        msgId: message.id.msgId,
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

function computeNonProbeWorkOperations(counts: IndexedDbOperationCounts): number {
    return counts.byOwner['al-work'] - (counts.byKind['work-page'] ?? 0) - (counts.byKind['work-probe'] ?? 0);
}
