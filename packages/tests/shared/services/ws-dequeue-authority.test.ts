import {
    describe,
    expect,
    it,
    onTestFinished
} from 'vitest';

import {
    newALBroadcastMessage,
    newALUnicastMessage,
    type ALMessage
} from '@shared/al-contracts/al-contract.ts';
import { decodePersistedALMessage } from '@shared/al-contracts/al-message-persistence-validation.ts';
import { createDefaultInMemoryALOutboundRuntimeStores } from '@shared/alm/al-runtime-stores.ts';
import {
    captureALOutboundCreationExpiry,
    toALOutboundCanonicalKey,
    toALOutboundIdentityEntry,
    toALOutboundIdentityKey,
    toALOutboundMessageReference
} from '@shared/alm/outbound/al-outbound-canonical-message.ts';
import type { ALOutboundRuntimeStores } from '@shared/alm/outbound/al-outbound-message-runtime.ts';
import { computeALOutboundDispatch } from '@shared/alm/outbound/compute-al-outbound-dispatch.ts';
import { EnqueuedType } from '@shared/api/api-config.ts';
import { EntityStatus, type ResourceEntry } from '@shared/queuebox/ResourceEntry.ts';
import { InboxOutboxEngine } from '@shared/services/InboxOutboxEngine.ts';
import { QueueBoxUtilities } from '@shared/services/queue-box-utilities.ts';
import { decodeWsQueueBoxServerPreparedMessage } from '@shared/services/ws-queue-box-server/decode-ws-queue-box-server-prepared-message.ts';
import type { WsQueueBoxServerPreparedMessage } from '@shared/services/ws-queue-box-server/ws-queue-box-server-outbound-planning.ts';
import { createDefaultWsQueueBoxServerService, type WsQueueBoxServerService } from '@shared/services/ws-queue-box-server/ws-queue-box-server-service.ts';
import { ConnectionContext, JsonWebSocketServer } from '@shared/websocket/json-web-socket-server.ts';

import { TestWebSocket } from '../websocket/test-web-socket.ts';

const SCOPE = { applicationId: 'app', workspaceId: 'workspace' };

describe('WS first dequeue authority', () => {
    it.each(['canonical-with-identity', 'canonical-without-identity', 'raw-with-identity', 'raw-without-proof'] as const)(
        'rejects %s before capturing admission or sending',
        async (shape) => {
            const fixture = createFixture();
            const message = createMessage(shape.startsWith('canonical') ? 'broadcast' : 'unicast');
            const raw = QueueBoxUtilities.toResourceEntryFromMsg(message, EnqueuedType.WS_OUTBOX);
            expect(decodePersistedALMessage(raw.resource)).toEqual(message);
            const entry = shape.startsWith('canonical')
                ? { ...raw, key: toALOutboundCanonicalKey(fixture.stores.admissionStore.canonicalScope, message) }
                : raw;
            if (shape === 'canonical-with-identity' || shape === 'raw-with-identity') {
                await fixture.stores.workQueue.enqueue(toALOutboundIdentityEntry(
                    toALOutboundMessageReference(fixture.stores.admissionStore.canonicalScope, entry, message),
                    entry,
                    captureALOutboundCreationExpiry(message)
                ));
            }
            await fixture.stores.workQueue.enqueue(entry);
            await fixture.engine.executeOnce();
            await expect.poll(async () => (await fixture.stores.workQueue.getItem(entry.key))?.status).toBe(EntityStatus.NON_RETRYABLE);
            expect(fixture.native.sent).toEqual([]);
            expect(await fixture.stores.admissionStore.hasSentMessageAdmission(message.id.msgId)).toBe(false);
        }
    );

    it.each(['colliding-raw', 'canonical-without-identity', 'canonical-with-identity'] as const)(
        'validates superseded %s before deciding that no send is needed',
        async (shape) => {
            const fixture = createFixture();
            const older: ALMessage = {
                ...createMessage('unicast'),
                ordering: { seq: 1 },
                qos: {
                    durability: { algo: 'local-outbox' },
                    supersedence: { algo: 'latest-wins', opts: { supersedenceKey: 'snapshot' } }
                }
            };
            const admitted = await fixture.service.enqueueOutboxIfAbsent(older, { admittedAudience: [], recipientScope: SCOPE });
            expect(admitted.verdict.kind).toBe('admitted');
            const canonical = admitted.entries[0]!;
            const newer: ALMessage = { ...older, id: { ...older.id, msgId: `${older.id.msgId}-newer` }, ordering: { seq: 2 } };
            expect((await fixture.service.enqueueOutboxIfAbsent(newer, { admittedAudience: [], recipientScope: SCOPE })).verdict.kind).toBe('admitted');
            expect(await fixture.stores.admissionStore.isMessageSuperseded(older)).toBe(true);
            await fixture.engine.executeOnce();
            await expect.poll(async () => (await fixture.stores.workQueue.getItem(canonical.key))?.status).toBe(EntityStatus.COMPLETED);
            const completed = await fixture.stores.workQueue.getItem(canonical.key);
            if (!completed || completed.key.topicId !== 'AL_OUTBOUND_MESSAGE') {
                throw new Error('Missing admitted canonical row');
            }

            const observed = shape === 'colliding-raw'
                ? QueueBoxUtilities.toResourceEntryFromMsg(older, EnqueuedType.WS_OUTBOX)
                : { ...completed, status: EntityStatus.NEW, dequeueAudit: { attempts: 0 } };
            if (shape === 'colliding-raw') {
                await fixture.stores.workQueue.enqueue(observed);
            }
            else {
                await fixture.stores.workQueue.replaceIfObserved(completed, observed);
            }
            if (shape === 'canonical-without-identity') {
                await fixture.stores.workQueue.removeItem(toALOutboundIdentityKey(canonical.key));
            }

            fixture.engine.wakeAfterExternalWrite();
            await fixture.engine.executeOnce();
            await expect.poll(async () => (await fixture.stores.workQueue.getItem(observed.key))?.status)
                .toBe(shape === 'canonical-with-identity' ? EntityStatus.COMPLETED : EntityStatus.NON_RETRYABLE);
            expect((await fixture.stores.workQueue.getItem(observed.key))?.dequeueAudit.attempts).toBe(1);
            expect(fixture.native.sent).toEqual([]);
        }
    );

    it('captures verified scoped unicast at the real dequeue boundary', async () => {
        const fixture = createFixture(async () => ({ admittedAudience: ['peer'], recipientScope: SCOPE }));
        const message = createMessage('unicast');
        const entry = QueueBoxUtilities.toResourceEntryFromMsg(message, EnqueuedType.WS_OUTBOX);
        await fixture.stores.workQueue.enqueue(entry);
        await fixture.engine.executeOnce();
        await expect.poll(() => fixture.native.sent.length).toBe(1);
        expect(await fixture.service.readCapturedPolicy(message, entry)).toMatchObject({ admittedAudience: ['peer'], recipientScope: SCOPE });
    });

    it('refuses a raw group-addressed unicast even with producer provenance', async () => {
        const fixture = createFixture(async () => ({ admittedAudience: ['peer'], recipientScope: SCOPE }));
        const message = newALUnicastMessage('server', { topicId: 'app.message', resourceId: 'resource', contextId: 'context' }, 'peer', 'message.v1', {}, {
            ttlMs: 30_000,
            qos: { durability: { algo: 'local-outbox' } },
            groupRef: { ...SCOPE, groupId: 'room' }
        });
        const entry = QueueBoxUtilities.toResourceEntryFromMsg(message, EnqueuedType.WS_OUTBOX);
        await fixture.stores.workQueue.enqueue(entry);
        await fixture.engine.executeOnce();
        await expect.poll(async () => (await fixture.stores.workQueue.getItem(entry.key))?.status).toBe(EntityStatus.NON_RETRYABLE);
        expect(fixture.native.sent).toEqual([]);
    });

    it('captures an explicitly empty frozen audience without widening it to the connected target', async () => {
        const fixture = createFixture(async () => ({ admittedAudience: [], recipientScope: SCOPE }));
        const message = createMessage('unicast');
        const entry = QueueBoxUtilities.toResourceEntryFromMsg(message, EnqueuedType.WS_OUTBOX);
        await fixture.stores.workQueue.enqueue(entry);
        await fixture.engine.executeOnce();
        await expect.poll(async () => fixture.stores.admissionStore.hasSentMessageAdmission(message.id.msgId)).toBe(true);
        expect(await fixture.service.readCapturedPolicy(message, entry)).toMatchObject({ admittedAudience: [], recipientScope: SCOPE });
        expect(fixture.native.sent).toEqual([]);
    });

    it('uses the captured policy of an admission that wins while the producer read is in flight', async () => {
        const stores = createDefaultInMemoryALOutboundRuntimeStores({ decodePrepared: decodeWsQueueBoxServerPreparedMessage });
        const fixture = createFixture(async (message, entry) => {
            await writeCompetingAdmission(stores, message, entry);
            return { admittedAudience: ['peer'], recipientScope: SCOPE };
        }, stores);
        const message = createMessage('unicast');
        const entry = QueueBoxUtilities.toResourceEntryFromMsg(message, EnqueuedType.WS_OUTBOX);
        await stores.workQueue.enqueue(entry);
        await fixture.engine.executeOnce();
        await expect.poll(async () => (await stores.workQueue.getItem(entry.key))?.status).toBe(EntityStatus.COMPLETED);
        expect(await fixture.service.readCapturedPolicy(message, entry)).toMatchObject({ admittedAudience: [], recipientScope: SCOPE });
        expect(fixture.native.sent).toEqual([]);
    });
});

function createMessage(mode: 'unicast' | 'broadcast'): ALMessage {
    const route = { topicId: 'app.message', resourceId: 'resource', contextId: 'context' };
    const options = { ttlMs: 30_000, qos: { durability: { algo: 'local-outbox' as const } } };
    return mode === 'unicast'
        ? newALUnicastMessage('server', route, 'peer', 'message.v1', {}, options)
        : newALBroadcastMessage('server', route, 'room', 'message.v1', {}, {
            ...options,
            groupRef: { ...SCOPE, groupId: 'room' }
        });
}

function createFixture(
    readProducerProvenance?: WsQueueBoxServerService.Input['readProducerProvenance'],
    stores = createDefaultInMemoryALOutboundRuntimeStores({ decodePrepared: decodeWsQueueBoxServerPreparedMessage })
) {
    const socket = new JsonWebSocketServer();
    const native = new TestWebSocket('ws://peer');
    native.open();
    socket.addConnection(new ConnectionContext({ id: 'peer', socket: native }));
    const engine = new InboxOutboxEngine();
    const input: WsQueueBoxServerService.Input = {
        name: 'server',
        socket,
        outbox: stores.workQueue,
        outboundStores: stores,
        queueEngine: engine,
        targetResolver: { resolveBroadcastRecipients: () => [{ peerId: 'peer', connectionId: 'peer' }] },
        readAuthenticatedConnectionScope: () => ({ scope: SCOPE, expiresAtEpochMs: Date.now() + 30_000 }),
        readProducerProvenance
    };
    const service = createDefaultWsQueueBoxServerService(input);
    onTestFinished(() => {
        service.dispose();
        engine.stop();
    });
    return { socket, native, engine, stores, service };
}

async function writeCompetingAdmission(
    stores: ALOutboundRuntimeStores<WsQueueBoxServerPreparedMessage>,
    message: ALMessage,
    entry: ResourceEntry
): Promise<void> {
    const read = await stores.admissionStore.readOutgoingMessage({
        msg: message,
        observedCanonicalEntry: entry,
        intent: 'dequeue',
        planner: () => ({ msg: message, dropReasonCode: undefined, lane: 'durable', preparedMessages: [], admittedAudience: [], recipientScope: SCOPE })
    });
    const computed = computeALOutboundDispatch({
        read,
        outboxEntry: entry,
        dispatchAtMs: Date.now(),
        intent: 'dequeue',
        phase: 'dequeue',
        options: { observedOutboxEntry: entry }
    });
    if (!computed.bundle || await stores.admissionStore.commitBundle(computed.bundle) !== 'committed') {
        throw new Error('Competing admission did not commit');
    }
}
