import { Temporal } from '@js-temporal/polyfill';
import {
    describe,
    expect,
    it,
    onTestFinished,
    vi
} from 'vitest';

import {
    newALBroadcastMessage,
    newALUnicastMessage,
    type ALMessage
} from '@shared/al-contracts/al-contract.ts';
import { decodePersistedALMessage } from '@shared/al-contracts/al-message-persistence-validation.ts';
import { ALAdmissionCorruptionError } from '@shared/alm/al-admission-decoder.ts';
import { createDefaultInMemoryALOutboundRuntimeStores } from '@shared/alm/al-runtime-stores.ts';
import type { ALOutboundCapturedPolicy } from '@shared/alm/outbound/admission/al-outbound-admission-validation.ts';
import {
    captureALOutboundCreationExpiry,
    toALOutboundCanonicalKey,
    toALOutboundIdentityEntry,
    toALOutboundIdentityKey,
    toALOutboundMessageReference
} from '@shared/alm/outbound/al-outbound-canonical-message.ts';
import type { ALOutboundRuntimeStores } from '@shared/alm/outbound/al-outbound-message-runtime.ts';
import { AL_OUTBOUND_WORK_PAGE_SIZE } from '@shared/alm/outbound/al-outbound-work-entry.ts';
import { computeALOutboundDispatch } from '@shared/alm/outbound/compute-al-outbound-dispatch.ts';
import { EnqueuedType } from '@shared/api/api-config.ts';
import { EntityStatus, type ResourceEntry } from '@shared/queuebox/ResourceEntry.ts';
import { InboxOutboxEngine } from '@shared/services/inbox-outbox-engine.ts';
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
            const raw = QueueBoxUtilities.toResourceEntryFromMsg(message, EnqueuedType.WS_OUTBOX, Temporal.Now.instant());
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
            expect(await fixture.stores.admissionStore.readMessageSupersedence([older])).toEqual([{ status: 'fulfilled', value: true }]);
            await fixture.engine.executeOnce();
            await expect.poll(async () => (await fixture.stores.workQueue.getItem(canonical.key))?.status).toBe(EntityStatus.COMPLETED);
            const completed = await fixture.stores.workQueue.getItem(canonical.key);
            if (!completed || completed.key.topicId !== 'AL_OUTBOUND_MESSAGE') {
                throw new Error('Missing admitted canonical row');
            }

            const observed = shape === 'colliding-raw'
                ? QueueBoxUtilities.toResourceEntryFromMsg(older, EnqueuedType.WS_OUTBOX, Temporal.Now.instant())
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

            fixture.engine.wakeAfterExternalWrite(new Set([EnqueuedType.WS_OUTBOX]));
            await fixture.engine.executeOnce();
            await expect.poll(async () => (await fixture.stores.workQueue.getItem(observed.key))?.status)
                .toBe(shape === 'canonical-with-identity' ? EntityStatus.COMPLETED : EntityStatus.NON_RETRYABLE);
            expect((await fixture.stores.workQueue.getItem(observed.key))?.dequeueAudit.attempts).toBe(1);
            expect(fixture.native.sent).toEqual([]);
        }
    );

    it('reads the authority and supersedence of a full dequeued group in two rounds', async () => {
        const rounds = createReadRounds();
        const stores = recordGroupReadPhase(
            createDefaultInMemoryALOutboundRuntimeStores({ decodePrepared: decodeWsQueueBoxServerPreparedMessage }),
            rounds
        );
        const fixture = createFixture(async () => {
            await rounds.enter();
            return { admittedAudience: ['peer'], recipientScope: SCOPE };
        }, stores);
        const entries = Array.from(
            { length: AL_OUTBOUND_WORK_PAGE_SIZE },
            (_, index) => QueueBoxUtilities.toResourceEntryFromMsg(createIndexedMessage(index), EnqueuedType.WS_OUTBOX, Temporal.Now.instant())
        );
        for (const entry of entries) {
            await stores.workQueue.enqueue(entry);
        }

        await fixture.engine.executeOnce();

        await expect.poll(() => fixture.native.sent.length).toBe(AL_OUTBOUND_WORK_PAGE_SIZE);
        // Two rows at a time, each reading its admission, its proof and its supersedence in turn, took 24 rounds.
        // The group reads its admission facts and supersedence in one round, and its proofs in the next.
        expect(rounds.reads()).toBeGreaterThanOrEqual(2 * AL_OUTBOUND_WORK_PAGE_SIZE);
        expect(rounds.rounds()).toBe(2);
    });

    it('captures verified scoped unicast at the real dequeue boundary', async () => {
        const fixture = createFixture(async () => ({ admittedAudience: ['peer'], recipientScope: SCOPE }));
        const message = createMessage('unicast');
        const entry = QueueBoxUtilities.toResourceEntryFromMsg(message, EnqueuedType.WS_OUTBOX, Temporal.Now.instant());
        await fixture.stores.workQueue.enqueue(entry);
        await fixture.engine.executeOnce();
        await expect.poll(() => fixture.native.sent.length).toBe(1);
        expect(await fixture.service.readCapturedPolicy(message, entry, undefined)).toMatchObject({ admittedAudience: ['peer'], recipientScope: SCOPE });
    });

    it('publishes each row of a dequeued group under the policy its commit wrote, in row order, reading none back', async () => {
        const fixture = createFixture(async () => ({ admittedAudience: ['peer'], recipientScope: SCOPE }));
        const published: PublishedDequeuedRow[] = [];
        fixture.service.onOutboxClusterPublishDo(async (message, entry, handoff) => {
            published.push({ message, entry, committedPolicy: handoff?.committedPolicy });
        });
        const storedReads = recordStoredPolicyReads(fixture.stores);
        const messages = [0, 1, 2].map(createIndexedMessage);
        for (const message of messages) {
            await fixture.stores.workQueue.enqueue(
                QueueBoxUtilities.toResourceEntryFromMsg(message, EnqueuedType.WS_OUTBOX, Temporal.Now.instant())
            );
        }

        await fixture.engine.executeOnce();

        await expect.poll(() => published.length).toBe(messages.length);
        expect(storedReads).toEqual([]);
        expect(published.map(({ message }) => message.id.msgId)).toEqual(messages.map((message) => message.id.msgId));
        for (const { message, entry, committedPolicy } of published) {
            expect(committedPolicy).toEqual(await fixture.service.readCapturedPolicy(message, entry, undefined));
        }
    });

    it('holds the awaited audience of an unpublished row under the policy its commit wrote, reading none back', async () => {
        const fixture = createFixture(async () => ({ admittedAudience: ['peer'], recipientScope: SCOPE }));
        fixture.socket.expectedConnections.expect({ id: 'awaited', generationId: 'generation', expiresAtEpochMs: Date.now() + 30_000 });
        const storedReads = recordStoredPolicyReads(fixture.stores);
        const heldAudiences: (readonly string[])[] = [];
        const holdForAudience = fixture.socket.expectedConnections.holdForAudience.bind(fixture.socket.expectedConnections);
        vi.spyOn(fixture.socket.expectedConnections, 'holdForAudience').mockImplementation((audience, send) => {
            heldAudiences.push(audience);
            return holdForAudience(audience, send);
        });
        const message = createMessage('unicast');
        await fixture.stores.workQueue.enqueue(QueueBoxUtilities.toResourceEntryFromMsg(message, EnqueuedType.WS_OUTBOX, Temporal.Now.instant()));

        await fixture.engine.executeOnce();

        await expect.poll(() => heldAudiences).toEqual([['peer']]);
        expect(storedReads).toEqual([]);
        expect(fixture.native.sent).toHaveLength(1);
    });

    it('refuses a handed policy that does not authorize the row as corruption, without reading the stored one', async () => {
        const fixture = createFixture();
        const storedReads = recordStoredPolicyReads(fixture.stores);
        const message = createMessage('unicast');
        const entry = QueueBoxUtilities.toResourceEntryFromMsg(message, EnqueuedType.WS_OUTBOX, Temporal.Now.instant());
        const unscoped: ALOutboundCapturedPolicy = {
            persist: true,
            ackTracking: null,
            retryTracking: null,
            repairTracking: null,
            supersedenceTracking: null,
            admittedAudience: ['peer']
        };

        await expect(fixture.service.readCapturedPolicy(message, entry, unscoped)).rejects.toBeInstanceOf(ALAdmissionCorruptionError);
        expect(await fixture.service.readCapturedPolicy(message, entry, { ...unscoped, recipientScope: SCOPE }))
            .toEqual({ ...unscoped, recipientScope: SCOPE });
        expect(storedReads).toEqual([]);
    });

    it('refuses a raw group-addressed unicast even with producer provenance', async () => {
        const fixture = createFixture(async () => ({ admittedAudience: ['peer'], recipientScope: SCOPE }));
        const message = newALUnicastMessage('server', { topicId: 'app.message', resourceId: 'resource', contextId: 'context' }, 'peer', 'message.v1', {}, {
            ttlMs: 30_000,
            qos: { durability: { algo: 'local-outbox' } },
            groupRef: { ...SCOPE, groupId: 'room' }
        });
        const entry = QueueBoxUtilities.toResourceEntryFromMsg(message, EnqueuedType.WS_OUTBOX, Temporal.Now.instant());
        await fixture.stores.workQueue.enqueue(entry);
        await fixture.engine.executeOnce();
        await expect.poll(async () => (await fixture.stores.workQueue.getItem(entry.key))?.status).toBe(EntityStatus.NON_RETRYABLE);
        expect(fixture.native.sent).toEqual([]);
    });

    it('captures an explicitly empty frozen audience without widening it to the connected target', async () => {
        const fixture = createFixture(async () => ({ admittedAudience: [], recipientScope: SCOPE }));
        const message = createMessage('unicast');
        const entry = QueueBoxUtilities.toResourceEntryFromMsg(message, EnqueuedType.WS_OUTBOX, Temporal.Now.instant());
        await fixture.stores.workQueue.enqueue(entry);
        await fixture.engine.executeOnce();
        await expect.poll(async () => fixture.stores.admissionStore.hasSentMessageAdmission(message.id.msgId)).toBe(true);
        expect(await fixture.service.readCapturedPolicy(message, entry, undefined)).toMatchObject({ admittedAudience: [], recipientScope: SCOPE });
        expect(fixture.native.sent).toEqual([]);
    });

    it('uses the captured policy of an admission that wins while the producer read is in flight', async () => {
        const stores = createDefaultInMemoryALOutboundRuntimeStores({ decodePrepared: decodeWsQueueBoxServerPreparedMessage });
        const fixture = createFixture(async (message, entry) => {
            await writeCompetingAdmission(stores, message, entry);
            return { admittedAudience: ['peer'], recipientScope: SCOPE };
        }, stores);
        const message = createMessage('unicast');
        const entry = QueueBoxUtilities.toResourceEntryFromMsg(message, EnqueuedType.WS_OUTBOX, Temporal.Now.instant());
        await stores.workQueue.enqueue(entry);
        await fixture.engine.executeOnce();
        await expect.poll(async () => (await stores.workQueue.getItem(entry.key))?.status).toBe(EntityStatus.COMPLETED);
        expect(await fixture.service.readCapturedPolicy(message, entry, undefined)).toMatchObject({ admittedAudience: [], recipientScope: SCOPE });
        expect(fixture.native.sent).toEqual([]);
    });
});

function createIndexedMessage(index: number): ALMessage {
    const route = { topicId: 'app.message', resourceId: `resource-${index}`, contextId: 'context' };
    return newALUnicastMessage('server', route, 'peer', 'message.v1', {}, { ttlMs: 30_000, qos: { durability: { algo: 'local-outbox' } } });
}

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

/** One row the server handed its cluster publisher, with the policy its commit wrote. */
interface PublishedDequeuedRow {
    readonly message: ALMessage;
    readonly entry: ResourceEntry;
    readonly committedPolicy: ALOutboundCapturedPolicy | undefined;
}

interface DequeueAuthorityFixture {
    readonly socket: JsonWebSocketServer;
    readonly native: TestWebSocket;
    readonly engine: InboxOutboxEngine;
    readonly stores: ALOutboundRuntimeStores<WsQueueBoxServerPreparedMessage>;
    readonly service: WsQueueBoxServerService;
}

function createFixture(
    readProducerProvenance?: WsQueueBoxServerService.Input['readProducerProvenance'],
    stores = createDefaultInMemoryALOutboundRuntimeStores({ decodePrepared: decodeWsQueueBoxServerPreparedMessage })
): DequeueAuthorityFixture {
    const socket = new JsonWebSocketServer();
    const native = new TestWebSocket('ws://peer');
    native.open();
    socket.addConnection(new ConnectionContext({ id: 'peer', socket: native }));
    const engine = new InboxOutboxEngine();
    const input: WsQueueBoxServerService.Input = {
        name: 'server',
        inboundVolatileStores: undefined,
        socket,
        outbox: stores.workQueue,
        outboundStores: stores,
        queueEngine: engine,
        targetResolver: { requiresFrozenAudience: () => false, resolveBroadcastRecipients: () => [{ peerId: 'peer', connectionId: 'peer' }] },
        readAuthenticatedConnectionScope: () => ({ scope: SCOPE, expiresAtEpochMs: Date.now() + 30_000 }),
        readProducerProvenance
    };
    const service = createDefaultWsQueueBoxServerService(input);
    onTestFinished(async () => {
        const cleanup = await Promise.allSettled([service.dispose(), engine.stop()]);
        const failure = cleanup.find((outcome) => outcome.status === 'rejected');
        if (failure?.status === 'rejected') {
            throw failure.reason;
        }
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

/** The message id of every stored captured-policy read, as the store answers it. */
function recordStoredPolicyReads(stores: ALOutboundRuntimeStores<WsQueueBoxServerPreparedMessage>): readonly string[] {
    const reads: string[] = [];
    const store = stores.admissionStore;
    const readCapturedPolicy = store.readCapturedPolicy.bind(store);
    vi.spyOn(store, 'readCapturedPolicy').mockImplementation(async (message, entry) => {
        reads.push(message.id.msgId);
        return await readCapturedPolicy(message, entry);
    });
    return reads;
}

interface ReadRounds {
    enter(): Promise<void>;
    reads(): number;
    rounds(): number;
}

/**
 * Holds every read until the next macrotask, as a batching backend answers one round's reads together: a read
 * issued only after an earlier read answered starts the next round.
 */
function createReadRounds(): ReadRounds {
    let reads = 0;
    let rounds = 0;
    let open: Promise<void> | undefined;
    return {
        enter: () => {
            reads += 1;
            if (open === undefined) {
                rounds += 1;
                open = new Promise((resolve) => {
                    setTimeout(() => {
                        open = undefined;
                        resolve();
                    }, 0);
                });
            }
            return open;
        },
        reads: () => reads,
        rounds: () => rounds
    };
}

/** Holds every admission-store read of the dequeue read phase in its round, until the first commit. */
function recordGroupReadPhase(
    stores: ALOutboundRuntimeStores<WsQueueBoxServerPreparedMessage>,
    rounds: ReadRounds
): ALOutboundRuntimeStores<WsQueueBoxServerPreparedMessage> {
    const store = stores.admissionStore;
    let committing = false;
    const hold = async (): Promise<void> => {
        if (!committing) {
            await rounds.enter();
        }
    };
    const readDequeueAdmissionFacts = store.readDequeueAdmissionFacts.bind(store);
    const readMessageSupersedence = store.readMessageSupersedence.bind(store);
    const readCapturedPolicy = store.readCapturedPolicy.bind(store);
    const commitBundle = store.commitBundle.bind(store);
    const commitBundles = store.commitBundles.bind(store);
    vi.spyOn(store, 'readDequeueAdmissionFacts').mockImplementation(async (message, entry) => {
        await hold();
        return await readDequeueAdmissionFacts(message, entry);
    });
    vi.spyOn(store, 'readMessageSupersedence').mockImplementation(async (messages) => {
        await hold();
        return await readMessageSupersedence(messages);
    });
    vi.spyOn(store, 'readCapturedPolicy').mockImplementation(async (message, entry) => {
        await hold();
        return await readCapturedPolicy(message, entry);
    });
    vi.spyOn(store, 'commitBundle').mockImplementation(async (bundle, observation) => {
        committing = true;
        return await commitBundle(bundle, observation);
    });
    vi.spyOn(store, 'commitBundles').mockImplementation(async (bundles) => {
        committing = true;
        return await commitBundles(bundles);
    });
    return stores;
}
