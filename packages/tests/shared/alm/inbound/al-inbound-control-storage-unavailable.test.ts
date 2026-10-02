import { afterEach, describe, expect, it, onTestFinished, vi } from 'vitest';

import { newALMulticastMessage, type ALMessage } from '@shared/al-contracts/al-contract.ts';
import { newALAckControlMessage } from '@shared/al-contracts/al-control.ts';
import { planALMessageHandling } from '@shared/al-contracts/al-policy.ts';
import { createDefaultInMemoryALInboundRuntimeStores } from '@shared/alm/al-runtime-stores.ts';
import type { ALInboundMessageRuntime, ALInboundRuntimeStores } from '@shared/alm/inbound/al-inbound-message-runtime.ts';
import type { ALInboundRuntimeDiagnosticsEvent } from '@shared/alm/inbound/al-inbound-runtime-diagnostics.ts';
import { decodeALInboundWorkEntry } from '@shared/alm/inbound/al-inbound-work-entry.ts';
import { createDefaultALInboundMessageRuntime } from '@shared/alm/inbound/create-default-al-inbound-message-runtime.ts';
import { QueueBoxUtilities } from '@shared/services/queue-box-utilities.ts';

const SCOPE = { applicationId: 'app-1', workspaceId: 'workspace-1' };

const SOURCE: ALInboundMessageRuntime.Source = { kind: 'ws-client', peerId: 'peer-2', authenticatedScope: SCOPE };

const UNPERSISTED = {
    kind: 'storage-unavailable',
    cause: 'quota',
    detail: 'QuotaExceededError: The quota has been exceeded.'
} as const;

afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
});

describe('inbound control whose outbound store cannot persist it', () => {
    // Recorded gap: the first attempt already committed the inbound admission, so the retry completes without handing
    // the control to the outbound owner again; the receipt timeout and the peer's re-ACK heal it.
    it('retries the admit-control replay claim once and completes it without a second hand-over', async () => {
        vi.useFakeTimers({ toFake: ['Date'] });
        const stores = createDefaultInMemoryALInboundRuntimeStores();
        await seedPendingAcknowledgement(stores);
        const commitBundle = stores.admissionStore.commitBundle.bind(stores.admissionStore);
        vi.spyOn(stores.admissionStore, 'commitBundle')
            .mockResolvedValueOnce('conflict')
            .mockImplementation(commitBundle);
        const handedOver: string[] = [];
        const { runtime } = createRuntime(stores, async (msg) => {
            handedOver.push(msg.id.msgId);
            return UNPERSISTED;
        });

        const pending = await runtime.admitIncomingMessage(createAcknowledgement(), SOURCE);

        expect(pending.right).toEqual({ kind: 'pending-admission' });
        await expect.poll(() => readAdmitControlStatuses(stores)).toEqual(['RETRY']);
        expect(handedOver).toEqual(['control-ack']);
        vi.setSystemTime(Date.now() + 600_000);
        await expect.poll(() => readAdmitControlStatuses(stores)).toEqual(['COMPLETED']);
        expect(handedOver).toEqual(['control-ack']);
    });

    // The carrier still reads an unhandled control; the diagnostic says it was storage, not a foreign control.
    it('answers an inline control not handled and names the storage failure in its admission outcome', async () => {
        vi.useFakeTimers({ toFake: ['Date'] });
        const stores = createDefaultInMemoryALInboundRuntimeStores();
        await seedPendingAcknowledgement(stores);
        const { runtime, diagnostics } = createRuntime(stores, async () => UNPERSISTED);

        const admitted = await runtime.admitIncomingMessage(createAcknowledgement(), SOURCE);

        expect(admitted.right).toEqual({ kind: 'control', handled: false });
        expect(diagnostics.filter((event) => event.kind === 'admission-outcome')).toMatchObject([{
            outcome: 'not-handled',
            reason: 'storage-unavailable: quota'
        }]);
    });

    // A control the inbound store itself cannot read is answered the same way, and named the same way.
    it('names an inline control its inbound store cannot read as a storage failure', async () => {
        const stores = createDefaultInMemoryALInboundRuntimeStores();
        vi.spyOn(stores.admissionStore, 'readControlDecisionSurface').mockRejectedValue(
            new DOMException('The quota has been exceeded.', 'QuotaExceededError')
        );
        const { runtime, diagnostics } = createRuntime(stores, async () => undefined);

        const admitted = await runtime.admitIncomingMessage(createAcknowledgement(), SOURCE);

        expect(admitted.right).toEqual({ kind: 'control', handled: false });
        expect(diagnostics.filter((event) => event.kind === 'admission-outcome')).toMatchObject([{
            outcome: 'not-handled',
            reason: 'storage-unavailable: quota'
        }]);
    });
});

interface InboundControlRuntime {
    readonly runtime: ALInboundMessageRuntime;
    readonly diagnostics: readonly ALInboundRuntimeDiagnosticsEvent[];
}

function createRuntime(
    stores: ALInboundRuntimeStores,
    onControlMessage: ALInboundMessageRuntime.Dependencies['onControlMessage']
): InboundControlRuntime {
    const diagnostics: ALInboundRuntimeDiagnosticsEvent[] = [];
    const runtime = createDefaultALInboundMessageRuntime({
        carrier: 'ws',
        selfPeerId: 'self',
        stores,
        planIncomingMessage: (msg, source, observations) =>
            planALMessageHandling(msg, {
                selfPeerId: 'self',
                fromPeerId: source.kind === 'trusted-server' ? undefined : source.peerId,
                connectedPeerIds: ['peer-1', 'peer-2'],
                groupMemberPeerIds: ['self', 'peer-1', 'peer-2'],
                overlayNeighborPeerIds: ['peer-2'],
                ...observations
            }),
        toInboxEntry: (msg) => QueueBoxUtilities.toResourceEntryFromMsg(msg, 'inbox'),
        dispatchInboxEntry: async () => {},
        sendControlMessages: async () => {},
        onControlMessage,
        diagnostics: (event) => diagnostics.push(event)
    });
    onTestFinished(() => runtime.dispose());
    return { runtime, diagnostics };
}

function createAcknowledgement(): ALMessage {
    return newALAckControlMessage(
        { v: 2, msgId: 'control-ack', ts: 1, senderId: 'peer-2' },
        {
            ackedMsgId: 'acked-msg',
            originPeerId: 'peer-1',
            logicalRecipientPeerId: 'peer-2',
            fromPeerId: 'peer-2',
            toPeerId: 'self',
            status: 'delivered',
            observedAtEpochMs: 1,
            carrier: 'ws'
        }
    );
}

/** The relayed message this receiver still waits on an acknowledgement for, from `peer-2`. */
async function seedPendingAcknowledgement(stores: ALInboundRuntimeStores): Promise<void> {
    const expireAtTimestamp = Date.now() + 300_000;
    const message = createRelayedMessage();
    const source = { kind: 'ws-client', peerId: 'peer-1', authenticatedScope: SCOPE } as const;
    const read = await stores.admissionStore.readIncomingMessage({
        msg: message,
        source,
        nowMs: Date.now(),
        prePlan: planALMessageHandling(message, { selfPeerId: 'self', nowMs: Date.now() })
    });
    await stores.admissionStore.commitMutations({
        senderId: 'peer-1',
        observations: read.observations,
        mutations: [{
            kind: 'set-msg-owner',
            value: { msgId: 'acked-msg', senderId: 'peer-1', source, supersedenceKey: null },
            expireAtTimestamp
        }, {
            kind: 'set-control-pending',
            msgId: 'acked-msg',
            senderId: 'peer-1',
            expireAtTimestamp,
            value: {
                kind: 'pending',
                value: {
                    toPeerId: 'peer-1',
                    status: 'subtree-complete',
                    localReady: false,
                    expectedFromPeerIds: ['peer-2'],
                    ackedFromPeerIds: [],
                    carrier: 'ws'
                }
            }
        }, {
            kind: 'set-control-owners',
            msgId: 'acked-msg',
            value: { ambiguous: false, values: [{ peerId: 'peer-2', senderId: 'peer-1' }] },
            expireAtTimestamp
        }]
    });
}

function createRelayedMessage(): ALMessage {
    const message = newALMulticastMessage(
        'peer-1',
        { topicId: 'chat', resourceId: 'acked-msg', contextId: 'group-1' },
        { applicationId: 'app-1', workspaceId: 'workspace-1', groupId: 'group-1' },
        'chat.message.v1',
        { text: 'relayed' },
        { seq: 1, reliability: 'at-least-once', ack: 'none', qos: { durability: { algo: 'volatile' } } }
    );
    return { ...message, id: { ...message.id, msgId: 'acked-msg' } };
}

async function readAdmitControlStatuses(stores: ALInboundRuntimeStores): Promise<readonly string[]> {
    const rows = await Promise.all(
        (await stores.workQueue.getAllKeys()).map(async (key) => await stores.workQueue.getItem(key))
    );
    return rows
        .filter((row) => row !== undefined)
        .filter((row) => decodeALInboundWorkEntry(row, stores.admissionStore.namespace).payload.kind === 'admit-control')
        .map((row) => row.status);
}
