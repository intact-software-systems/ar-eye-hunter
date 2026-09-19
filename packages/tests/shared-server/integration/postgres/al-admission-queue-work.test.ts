import { Temporal } from '@js-temporal/polyfill';
import { PSqlResourceInboxEntryRepository } from '@shared-server/queuebox/postgres/p-sql-resource-inbox-entry-repository.ts';
import { createTestALOutboundWorkPort } from '@shared-test/shared/create-test-al-outbound-work-port.ts';
import {
    describe,
    expect,
    it,
    onTestFinished,
    vi
} from 'vitest';
import { peekOutboundWorkReadyAt } from '../../../shared/alm/outbound-runtime-test-fixture.ts';

import { PSqlAdmissionWorkBackend } from '@shared-server/al-runtime/postgres/p-sql-admission-work-backend.ts';
import { newALUnicastMessage, type ALMessage } from '@shared/al-contracts/al-contract.ts';
import { decodePersistedALMessage } from '@shared/al-contracts/al-message-persistence-validation.ts';
import { ALAdmissionCorruptionError } from '@shared/alm/al-admission-decoder.ts';
import { normalizeALRuntimeStoreRetention } from '@shared/alm/ALStoreRetention.ts';
import { createALOutboundAdmissionStore, type ALOutboundAdmissionStore } from '@shared/alm/outbound/admission/al-outbound-admission-store.ts';
import { toALOutboundCanonicalKey, toALOutboundIdentityKey } from '@shared/alm/outbound/al-outbound-canonical-message.ts';
import type { ALOutboundRuntimeStores } from '@shared/alm/outbound/al-outbound-message-runtime.ts';
import {
    decodeALOutboundTransportMessage,
    toALOutboundTransportMessage,
    type ALOutboundTransportMessage
} from '@shared/alm/outbound/al-outbound-transport-message.ts';
import { toALOutboundWorkKey } from '@shared/alm/outbound/al-outbound-work-entry.ts';
import { computeALOutboundDispatch, type ALOutboundComputedDto } from '@shared/alm/outbound/compute-al-outbound-dispatch.ts';
import { createDefaultALOutboundMessageRuntime } from '@shared/alm/outbound/create-default-al-outbound-message-runtime.ts';
import { InMemoryQueueBox } from '@shared/queuebox/in-memory-queue-box.ts';
import {
    createDefaultResourceInboxDequeuer,
    NonRetryableException,
    ResourceInboxHandlerEntryError
} from '@shared/queuebox/resource-inbox/create-default-resource-inbox-dequeuer.ts';
import { ResourceInboxResilience } from '@shared/queuebox/resource-inbox/resource-inbox-resilience.ts';
import {
    EntityStatus,
    NEVER_EXPIRE_TS,
    type Key,
    type ResourceEntry
} from '@shared/queuebox/ResourceEntry.ts';
import { CircuitBreakerPolicy } from '@shared/resilience/circuit-breaker.ts';
import { QueueBoxUtilities } from '@shared/services/queue-box-utilities.ts';

import {
    createRuntimeStatePostgresSql,
    requirePostgresDatabaseUrl,
    type PostgresSql
} from '../../runtime-state/postgres/postgres-runtime-state-client-fixtures.ts';

const postgresIt = process.env.RALLAR_POSTGRES_INTEGRATION === '1' ? it : it.skip;

describe('Postgres atomic AL admission and QueueBox work', () => {
    postgresIt('rejects one malformed work payload while an independent worker completes the valid payload', async () => {
        const { backend, other, entry } = await createStorage();
        const namespace = entry.key.contextId;
        const store = createALOutboundAdmissionStore({
            decodePrepared: decodeALOutboundTransportMessage,
            nowMs: Date.now,
            namespace,
            canonicalScope: namespace,
            backend,
            supersedenceTrackTtlMs: 60_000,
            retention: normalizeALRuntimeStoreRetention()
        });
        await store.commitBundle({
            senderId: 'self',
            mutations: [],
            durableEffects: ['malformed', 'valid'].map((msgId) => ({
                effectId: msgId,
                payload: { kind: 'ack-timeout', msgId }
            }))
        });
        const malformedKey = toALOutboundWorkKey(namespace, 'malformed');
        const original = await other.workQueue.getItem(malformedKey);
        if (original === undefined) {
            throw new Error('Expected malformed-work fixture');
        }
        expect(await other.workQueue.replaceIfObserved(original, { ...original, resource: '{invalid-json' }))
            .not.toBeNull();

        await runOutboundWorkBatch({ admissionStore: store, workQueue: backend.workQueue });

        expect(await other.workQueue.getItem(malformedKey)).toMatchObject({
            status: EntityStatus.NON_RETRYABLE,
            resource: '{invalid-json',
            dequeueAudit: { attempts: 1, nextTs: undefined }
        });
        expect(await other.workQueue.getItem(toALOutboundWorkKey(namespace, 'valid')))
            .toMatchObject({ status: EntityStatus.COMPLETED });
        expect(await peekOutboundWorkReadyAt(backend.workQueue, namespace)).toBeUndefined();
    });

    postgresIt('commits one canonical payload, full identity and compact action, then reloads through another connection', async () => {
        const { backend, other, entry, ownedKeys } = await createStorage();
        const settings = {
            nowMs: Date.now,
            namespace: entry.key.contextId,
            canonicalScope: `local-session:${'long-scope/'.repeat(60)}:${entry.key.contextId}`,
            supersedenceTrackTtlMs: 60_000,
            retention: normalizeALRuntimeStoreRetention()
        };
        const first = createALOutboundAdmissionStore({
            ...settings,
            decodePrepared: decodeALOutboundTransportMessage,
            backend
        });
        const original = createSupersedingMessage('sender', 1);
        const message = {
            ...original,
            id: {
                ...original.id,
                senderId: 'sender/'.repeat(30),
                msgId: `message/${entry.key.contextId}/${'long/'.repeat(50)}`,
                sessionId: 'session/'.repeat(30),
                traceId: 'trace/'.repeat(30)
            }
        };
        const decision = await readSupersedenceDecision({ store: first, message: message, nowMs: Date.now });
        const canonicalKey = decision.entries[0].key;
        const identityKey = toALOutboundIdentityKey(canonicalKey);
        ownedKeys.push(canonicalKey, identityKey);
        expect(await first.commitBundle(decision.bundle!)).toBe('committed');

        const restarted = createALOutboundAdmissionStore({
            ...settings,
            decodePrepared: decodeALOutboundTransportMessage,
            backend: other
        });
        expect((await restarted.readSentMessage(message.id.msgId))?.msg).toEqual(message);
        const canonical = await other.workQueue.getItem(canonicalKey);
        const identity = await other.workQueue.getItem(identityKey);
        expect(canonical?.resource).toBe(JSON.stringify(message));
        expect(JSON.parse(identity!.resource).reference).toMatchObject({
            scope: settings.canonicalScope,
            msgId: message.id.msgId,
            senderId: message.id.senderId
        });
        expect(identity?.audit.expiryTs.epochMilliseconds).toBe(message.constraints?.expiresAtMs);
        const restartedWork = createOutboundWork({ admissionStore: restarted, workQueue: other.workQueue });
        const [action] = await restartedWork.claim(10);
        expect(action!.work.canonicalMessage).toEqual(message);
        expect(action!.claim.entry.resource).not.toContain(message.payload.resource);
        for (const row of [canonical!, identity!, action!.claim.entry]) {
            expect(row.key.topicId.length).toBeLessThanOrEqual(36);
            expect(row.key.resourceId.length).toBeLessThanOrEqual(128);
            expect(row.key.contextId.length).toBeLessThanOrEqual(128);
        }
        await restartedWork.port.release(action!.claim, { status: 'completed' });
        expect((await readSupersedenceDecision({ store: restarted, message: message, nowMs: Date.now })).status).toBe('duplicate');
        expect(await createOutboundWork({ admissionStore: first, workQueue: backend.workQueue }).claim(10)).toEqual([]);
        const conflicting = {
            ...identity!,
            resource: JSON.stringify({
                ...JSON.parse(identity!.resource),
                reference: { ...JSON.parse(identity!.resource).reference, scope: 'conflicting-local-session' }
            })
        };
        expect(await other.workQueue.replaceIfObserved(identity!, conflicting)).not.toBeNull();
        await expect(first.readSentMessage(message.id.msgId)).rejects.toBeInstanceOf(ALAdmissionCorruptionError);
        expect((await other.workQueue.getItem(canonicalKey))?.resource).toBe(canonical?.resource);
        expect(await createOutboundWork({ admissionStore: first, workQueue: backend.workQueue }).claim(10)).toEqual([]);
    });

    postgresIt('aborts canonical payload, identity, action and metadata together when the final action slot races', async () => {
        const { backend, other, entry, ownedKeys } = await createStorage();
        const store = createALOutboundAdmissionStore({
            nowMs: Date.now,
            canonicalScope: entry.key.contextId,
            decodePrepared: decodeALOutboundTransportMessage,
            namespace: entry.key.contextId,
            backend,
            supersedenceTrackTtlMs: 60_000,
            retention: normalizeALRuntimeStoreRetention()
        });
        const message = createSupersedingMessage('sender', 1);
        const decision = await readSupersedenceDecision({ store, message, nowMs: Date.now });
        const canonicalKey = decision.entries[0].key;
        const identityKey = toALOutboundIdentityKey(canonicalKey);
        const actionKey = toALOutboundWorkKey(store.namespace, decision.bundle!.durableEffects[0].effectId);
        ownedKeys.push(canonicalKey, identityKey, actionKey);
        // The racing row outlives the aborted bundle, so it is owned like the rest: the shared
        // Postgres queue is scanned by suites that decode every row they meet, and this one is
        // written for its key alone.
        const independentWinner = JSON.stringify({ marker: 'independent winner' });
        const write = backend.write.bind(backend);
        const race = vi.spyOn(backend, 'write').mockImplementationOnce((operation) =>
            write(async (transaction) => {
                const result = await operation(transaction);
                await other.workQueue.enqueue({ ...entry, key: actionKey, resource: independentWinner });
                return result;
            })
        );
        onTestFinished(() => race.mockRestore());

        expect(await store.commitBundle(decision.bundle!)).toBe('conflict');
        expect(await other.workQueue.getItem(canonicalKey)).toBeUndefined();
        expect(await other.workQueue.getItem(identityKey)).toBeUndefined();
        expect(await store.readSentMessage(message.id.msgId)).toBeUndefined();
        expect(await other.read(`${store.namespace}:msg-owner:${message.id.msgId}`, (value) => value)).toBeUndefined();
        expect((await other.workQueue.getItem(actionKey))?.resource).toBe(independentWinner);
    });

    postgresIt('refuses concurrent conflicting sender reuse of one globally addressed message id without overwriting metadata', async () => {
        const { backend, other, entry, ownedKeys } = await createStorage();
        const settings = {
            nowMs: Date.now,
            namespace: entry.key.contextId,
            canonicalScope: entry.key.contextId,
            supersedenceTrackTtlMs: 60_000,
            retention: normalizeALRuntimeStoreRetention()
        };
        const first = createALOutboundAdmissionStore({
            ...settings,
            decodePrepared: decodeALOutboundTransportMessage,
            backend
        });
        const second = createALOutboundAdmissionStore({
            ...settings,
            decodePrepared: decodeALOutboundTransportMessage,
            backend: other
        });
        const original = createSupersedingMessage('sender-a', 1);
        const conflicting = { ...original, id: { ...original.id, senderId: 'sender-b' } };
        const firstDecision = await readSupersedenceDecision({ store: first, message: original, supersedenceKey: 'sender-a', nowMs: Date.now });
        const secondDecision = await readSupersedenceDecision({ store: second, message: conflicting, supersedenceKey: 'sender-b', nowMs: Date.now });
        for (const decision of [firstDecision, secondDecision]) {
            ownedKeys.push(decision.entries[0].key, toALOutboundIdentityKey(decision.entries[0].key));
        }
        expect(await first.commitBundle(firstDecision.bundle!)).toBe('committed');
        await expect(second.commitBundle(secondDecision.bundle!)).rejects.toBeInstanceOf(ALAdmissionCorruptionError);
        expect((await second.readSentMessage(original.id.msgId))?.msg.id.senderId).toBe('sender-a');
        expect(await other.workQueue.getItem(secondDecision.entries[0].key)).toBeUndefined();
    });

    postgresIt('keeps non-retryable work out of normal, failed, timeout and exhaustion recovery claims', async () => {
        const { backend, other, entry } = await createStorage();
        const dueAt = Temporal.Now.instant().subtract({ seconds: 10 });
        await backend.workQueue.enqueue({
            ...entry,
            status: EntityStatus.RETRY,
            dequeueAudit: { attempts: 19, startTs: dueAt, endTs: dueAt, nextTs: dueAt }
        });
        const duration = Temporal.Duration.from({ seconds: 10 });
        const resilience = ResourceInboxResilience.createDefault({
            circuitBreakerPolicy: new CircuitBreakerPolicy(10, duration, duration, duration),
            initialRate: 1,
            maxRate: 10,
            concurrencyIncreaseStep: 1,
            concurrencyReduceStep: 1
        });
        const types = new Set([entry.typeId]);
        const controller = createDefaultResourceInboxDequeuer<string>({
            repository: backend.workQueue,
            typesToDequeue: () => types,
            maxToReserve: () => 1,
            maxNumToDequeue: 10,
            resilience: resilience
        });

        await controller.dequeueForCompute(async () => {
            throw new NonRetryableException('Malformed persisted message');
        });

        expect(await other.workQueue.getItem(entry.key)).toMatchObject({
            status: EntityStatus.NON_RETRYABLE,
            dequeueAudit: { attempts: 20, nextTs: undefined }
        });
        const reservation = { maxToReserve: 1, maxAttempts: 21 };
        expect(
            await other.workQueue.reserveEntries({
                typeIds: types,
                statusIds: new Set([EntityStatus.NEW, EntityStatus.RETRY, EntityStatus.FAILED]),
                reservationInput: reservation
            })
        ).toEqual(new Map());
        expect(
            await other.workQueue.reserveTimeoutEntries({
                typeIds: types,
                reservationInput: reservation,
                timeSinceStartTs: Temporal.Duration.from({ milliseconds: 0 })
            })
        )
            .toEqual(new Map());
        expect(
            await other.workQueue.reserveRetryExhaustionFinalizations(types, {
                processingAttempts: 20,
                maxToReserve: 1,
                staleAfterMs: 0
            })
        ).toEqual(new Map());
    });

    postgresIt('redelivers the exact persisted message after a handler captures facts and then fails', async () => {
        const { backend, other, entry } = await createStorage();
        await backend.workQueue.enqueue(entry);
        const duration = Temporal.Duration.from({ seconds: 10 });
        const resilience = ResourceInboxResilience.createDefault({
            circuitBreakerPolicy: new CircuitBreakerPolicy(10, duration, duration, duration),
            initialRate: 1,
            maxRate: 10,
            concurrencyIncreaseStep: 1,
            concurrencyReduceStep: 1
        });
        const controller = createDefaultResourceInboxDequeuer<string>({
            repository: backend.workQueue,
            typesToDequeue: () => new Set([entry.typeId]),
            maxToReserve: () => 1,
            maxNumToDequeue: 10,
            resilience: resilience
        });
        const accepted: string[] = [];
        await expect.poll(async () => {
            await controller.dequeueForCompute(async (_key, attempt) => {
                const reserved = attempt.entry;
                if (reserved.dequeueAudit.attempts === 1) {
                    const replacement = await other.workQueue.replaceIfObserved(reserved, { ...reserved, resource: 'captured immutable facts' });
                    if (replacement === null) {
                        throw new Error('Expected authority replacement to win');
                    }
                    expect(reserved.resource).toBe('message-work');
                    throw new ResourceInboxHandlerEntryError(replacement, new Error('Later domain write conflicted'));
                }
                accepted.push(reserved.resource);
                return reserved.resource;
            });
            return await other.workQueue.getItem(entry.key);
        }, { timeout: 5_000 }).toMatchObject({ status: EntityStatus.COMPLETED, dequeueAudit: { attempts: 2 } });
        expect(accepted).toEqual(['captured immutable facts']);
    });

    postgresIt('rejects a cross-sender decision computed before another connection fills its shared slot', async () => {
        const { backend, other, entry, ownedKeys } = await createStorage();
        const settings = {
            nowMs: Date.now,
            namespace: entry.key.contextId,
            canonicalScope: entry.key.contextId,
            supersedenceTrackTtlMs: 60_000,
            retention: normalizeALRuntimeStoreRetention()
        };
        const first = createALOutboundAdmissionStore({
            ...settings,
            decodePrepared: decodeALOutboundTransportMessage,
            backend
        });
        const second = createALOutboundAdmissionStore({
            ...settings,
            decodePrepared: decodeALOutboundTransportMessage,
            backend: other
        });
        const older = createSupersedingMessage('sender-a', 1);
        const newer = createSupersedingMessage('sender-b', 2);
        const oldDecision = await readSupersedenceDecision({ store: first, message: older, nowMs: Date.now });
        const newDecision = await readSupersedenceDecision({ store: second, message: newer, nowMs: Date.now });
        ownedKeys.push(
            oldDecision.entries[0].key,
            toALOutboundIdentityKey(oldDecision.entries[0].key),
            newDecision.entries[0].key,
            toALOutboundIdentityKey(newDecision.entries[0].key)
        );

        expect(await second.commitBundle(newDecision.bundle!)).toBe('committed');
        expect(await first.commitBundle(oldDecision.bundle!)).toBe('conflict');
        expect(await first.readSentMessage(older.id.msgId)).toBeUndefined();
        const pending = await createOutboundWork({ admissionStore: first, workQueue: backend.workQueue }).claim(10);
        expect(
            pending.map(({ work }) => work.payload.kind === 'send-prepared' ? work.payload.message.msgId : '')
        ).toEqual([newer.id.msgId]);
        const retried = await readSupersedenceDecision({ store: first, message: older, nowMs: Date.now });
        expect(retried.status).toBe('superseded');
        expect(retried.bundle).toBeUndefined();
    });

    postgresIt('reclaims exhausted work only for the requested type and fences the crashed worker', async () => {
        const { backend, other, entry } = await createStorage();
        const exhausted: ResourceEntry = {
            ...entry,
            status: EntityStatus.RESERVED,
            dequeueAudit: { attempts: 20, startTs: Temporal.Now.instant().subtract({ seconds: 11 }) }
        };
        const unrelated = { ...exhausted, typeId: 'unrelated', key: { ...entry.key, resourceId: 'unrelated' } };
        const fresh = {
            ...exhausted,
            key: { ...entry.key, resourceId: 'fresh' },
            dequeueAudit: { attempts: 20, startTs: Temporal.Now.instant().add({ seconds: 30 }) }
        };
        const retryable = {
            ...exhausted,
            key: { ...entry.key, resourceId: 'retryable' },
            dequeueAudit: { ...exhausted.dequeueAudit, attempts: 19 }
        };
        const expired = {
            ...exhausted,
            key: { ...entry.key, resourceId: 'expired' },
            audit: { ...entry.audit, expiryTs: Temporal.Now.instant().subtract({ seconds: 1 }) }
        };
        await backend.workQueue.enqueue(exhausted);
        for (const excluded of [unrelated, fresh, retryable, expired]) {
            await backend.workQueue.enqueue(excluded);
        }
        const observed = await backend.workQueue.getItem(entry.key);
        const observedUnrelated = await backend.workQueue.getItem(unrelated.key);
        const finalized = await other.workQueue.reserveRetryExhaustionFinalizations(new Set([entry.typeId]), {
            processingAttempts: 20,
            maxToReserve: 2,
            staleAfterMs: 10_000
        });
        expect([...finalized.values()]).toMatchObject([{
            entry: { key: entry.key, status: EntityStatus.RESERVED, dequeueAudit: { attempts: 21 } }
        }]);
        const [{ entry: reservation }] = [...finalized.values()];
        await expect(backend.workQueue.releaseEntries([observed!], { status: EntityStatus.COMPLETED, delayMs: null }))
            .rejects.toMatchObject({ code: 'resource-inbox-lost-reservation' });
        await other.workQueue.releaseEntries([reservation], { status: EntityStatus.FAILED, delayMs: null });
        expect(await backend.workQueue.getItem(entry.key)).toMatchObject({ status: EntityStatus.FAILED });
        expect(await backend.workQueue.getItem(unrelated.key)).toEqual(observedUnrelated);
    });

    postgresIt('commits state and queue work visible to an independent worker', async () => {
        const { backend, other, entry } = await createStorage();
        await backend.write(async (transaction) => {
            await transaction.readWork(entry.key);
            await transaction.set('admitted', 'accepted');
            transaction.writeWork(entry);
        });
        expect(await other.read('admitted', (value) => value)).toBe('accepted');
        const reserved = await other.workQueue.reserveEntries({
            typeIds: new Set([entry.typeId]),
            statusIds: new Set([EntityStatus.NEW]),
            reservationInput: 1
        });
        expect([...reserved.values()]).toMatchObject([{
            key: entry.key,
            resource: entry.resource,
            status: EntityStatus.RESERVED,
            dequeueAudit: { attempts: 1 }
        }]);
    });

    postgresIt('rolls back admission when an independent queue writer wins the observed empty slot', async () => {
        const { backend, other, entry } = await createStorage();
        await expect(backend.write(async (transaction) => {
            expect(await transaction.readWork(entry.key)).toBeUndefined();
            await other.workQueue.enqueueIfAbsent({ ...entry, resource: 'winner' });
            await transaction.set('admitted', 'loser');
            transaction.writeWork(entry);
        })).rejects.toMatchObject({ name: 'ALAdmissionBackendConflictError' });
        expect(await other.read('admitted', (value) => value)).toBeUndefined();
        expect(await other.workQueue.getItem(entry.key)).toMatchObject({ resource: 'winner' });
    });

    postgresIt('rolls back earlier work in a batch when the final observed queue slot conflicts', async () => {
        const { backend, other, entry } = await createStorage();
        const second = { ...entry, key: { ...entry.key, resourceId: 'last' } };
        await other.workQueue.enqueue(second);
        await expect(backend.write(async (transaction) => {
            await transaction.readWork(entry.key);
            await transaction.readWork(second.key);
            await other.workQueue.reserveEntries({ typeIds: new Set([entry.typeId]), statusIds: new Set([EntityStatus.NEW]), reservationInput: 1 });
            await transaction.set('admitted', 'stale');
            transaction.writeWork(entry);
            transaction.writeWork({ ...second, resource: 'stale' });
        })).rejects.toMatchObject({ name: 'ALAdmissionBackendConflictError' });
        expect(await other.read('admitted', (value) => value)).toBeUndefined();
        expect(await other.workQueue.getItem(entry.key)).toBeUndefined();
        expect(await other.workQueue.getItem(second.key)).toMatchObject({ status: EntityStatus.RESERVED });
    });

    postgresIt('reuses terminal work without changing the logical identity or computed value', async () => {
        const { backend, other, entry } = await createStorage();
        await other.workQueue.enqueue({ ...entry, status: EntityStatus.COMPLETED });
        await backend.write(async (transaction) => {
            const observed = await transaction.readWork(entry.key);
            expect(observed?.status).toBe(EntityStatus.COMPLETED);
            observed!.status = EntityStatus.FAILED;
            expect((await transaction.readWork(entry.key))?.status).toBe(EntityStatus.COMPLETED);
            transaction.writeWork(entry);
        });
        expect(await other.workQueue.getItem(entry.key)).toMatchObject(entry);
        expect(entry.status).toBe(EntityStatus.NEW);
        expect(entry.dequeueAudit.attempts).toBe(0);
    });

    postgresIt('fences an old worker after terminal work is reused at the same key', async () => {
        const { backend, other, entry } = await createStorage();
        await backend.workQueue.enqueue(entry);
        const [old] =
            (await backend.workQueue.reserveEntries({ typeIds: new Set([entry.typeId]), statusIds: new Set([EntityStatus.NEW]), reservationInput: 1 }))
                .values();
        await backend.workQueue.releaseEntries([old], { status: EntityStatus.COMPLETED, delayMs: null });
        await other.workQueue.enqueue({ ...entry, resource: 'later-work' });
        const [current] =
            (await other.workQueue.reserveEntries({ typeIds: new Set([entry.typeId]), statusIds: new Set([EntityStatus.NEW]), reservationInput: 1 })).values();
        expect(old.dequeueAudit.attempts).toBe(current.dequeueAudit.attempts);
        await expect(backend.workQueue.releaseEntries([old], { status: EntityStatus.COMPLETED, delayMs: null }))
            .rejects.toMatchObject({ code: 'resource-inbox-lost-reservation' });
        expect(await other.workQueue.getItem(entry.key)).toEqual(current);
    });

    postgresIt.each([-1, 0, 1, null])('checks execution deadline after deferred SQL mutations at offset %s', async (offset) => {
        const deadline = Date.now() + 60_000;
        let nowMs = deadline - 100;
        const { backend, other, entry } = await createStorage(() => nowMs);
        const insert = PSqlResourceInboxEntryRepository.prototype.tryWriteComputedIfAbsentOrReplaceExpired;
        const spy = vi.spyOn(PSqlResourceInboxEntryRepository.prototype, 'tryWriteComputedIfAbsentOrReplaceExpired')
            .mockImplementation(async function (this: PSqlResourceInboxEntryRepository, values) {
                const result = await insert.call(this, values);
                nowMs = deadline + (offset ?? 1);
                return result;
            });
        onTestFinished(() => spy.mockRestore());
        const attempt = backend.write(async (transaction) => {
            await transaction.readWork(entry.key);
            transaction.writeWork(entry);
            await transaction.set('admitted', 'eligible', deadline + 60_000);
            return 'committed';
        }, offset === null ? null : deadline);
        if (offset === null || offset < 0) {
            await expect(attempt).resolves.toBe('committed');
            expect(await other.read('admitted', String)).toBe('eligible');
            expect(await other.workQueue.getItem(entry.key)).toMatchObject(entry);
        }
        else {
            await expect(attempt).rejects.toMatchObject({ name: 'PersistenceWriteExpiredError' });
            expect(await other.read('admitted', String)).toBeUndefined();
            expect(await other.workQueue.getItem(entry.key)).toBeUndefined();
        }
    });

    postgresIt('persists neither state nor work after the admission callback rejects', async () => {
        const { backend, other, entry } = await createStorage();
        await expect(backend.write(async (transaction) => {
            await transaction.readWork(entry.key);
            transaction.writeWork(entry);
            await transaction.set('admitted', 'rejected');
            throw new Error('Rejected admission');
        })).rejects.toThrow('Rejected admission');
        expect(await other.read('admitted', (value) => value)).toBeUndefined();
        expect(await other.workQueue.getItem(entry.key)).toBeUndefined();
    });
});

interface AdmissionStorageFixture {
    readonly backend: PSqlAdmissionWorkBackend;
    readonly other: PSqlAdmissionWorkBackend;
    readonly entry: ResourceEntry;
    readonly ownedKeys: Key[];
}

/** Claims and decodes work the way the owner's batch does, for a store the test built itself. */
function createOutboundWork(stores: ALOutboundRuntimeStores<ALOutboundTransportMessage>) {
    const port = createTestALOutboundWorkPort({ ...stores, nowMs: Date.now });
    return {
        port,
        claim: async (maxCount: number) => {
            const claims = await port.claim({ maxCount, observedEntries: undefined });
            return await Promise.all(claims.map(async (claim) => ({
                claim,
                work: await stores.admissionStore.readWorkSnapshot(claim.entry)
            })));
        }
    };
}

/** Runs one owner batch: a row it cannot decode is rejected, and a valid sibling still runs. */
async function runOutboundWorkBatch(
    stores: ALOutboundRuntimeStores<ALOutboundTransportMessage>
): Promise<void> {
    const runtime = createDefaultALOutboundMessageRuntime({
        carrier: 'ws',
        stores,
        outbox: new InMemoryQueueBox(new Map()),
        decodePreparedMessage: decodeALOutboundTransportMessage,
        toOutboxEntry: (message) => QueueBoxUtilities.toResourceEntryFromMsg(message, 'outbox'),
        readMessageFromEntry: (entry) => decodePersistedALMessage(entry.resource),
        planOutgoingMessage: (msg) => ({ msg, dropReasonCode: undefined, persist: false, preparedMessages: [] }),
        sendPreparedMessage: async () => ({ status: 'sent' as const, submissionAttempted: true })
    });
    try {
        await runtime.ready();
    }
    finally {
        runtime.dispose();
    }
}

async function createStorage(
    nowMs: () => number = Date.now,
    namespace: string = crypto.randomUUID()
): Promise<AdmissionStorageFixture> {
    const ownedKeys: Key[] = [];
    const sql = await createRuntimeStatePostgresSql(requirePostgresDatabaseUrl());
    onTestFinished(async () => {
        try {
            await cleanupStorage({ sql, namespace, ownedKeys });
        }
        finally {
            await sql.end();
        }
    });
    const otherSql = await createRuntimeStatePostgresSql(requirePostgresDatabaseUrl());
    onTestFinished(() => otherSql.end());
    return {
        backend: new PSqlAdmissionWorkBackend(sql, namespace, nowMs),
        other: new PSqlAdmissionWorkBackend(otherSql, namespace),
        entry: createEntry(namespace),
        ownedKeys
    };
}

function createEntry(namespace: string): ResourceEntry {
    return {
        key: { topicId: 'alm-work', resourceId: 'first', contextId: namespace },
        typeId: namespace,
        resource: 'message-work',
        status: EntityStatus.NEW,
        audit: {
            date: Temporal.PlainTime.from('12:00:00'),
            createdBy: 'sender',
            createdTs: Temporal.PlainDateTime.from('2026-09-06T12:00:00'),
            expiryTs: NEVER_EXPIRE_TS
        },
        dequeueAudit: { attempts: 0 }
    };
}

function createSupersedingMessage(senderId: string, sequence: number): ALMessage {
    const message = newALUnicastMessage(
        senderId,
        {
            topicId: 'chat',
            resourceId: `message-${sequence}`,
            contextId: 'shared-topic'
        },
        'recipient',
        'chat.message.v1',
        { sequence },
        { ttlMs: 30_000 }
    );
    return { ...message, ordering: { seq: sequence, orderingKey: 'shared-topic' } };
}

interface ReadSupersedenceDecisionInput {
    readonly store: ALOutboundAdmissionStore<ALOutboundTransportMessage>;
    readonly message: ALMessage;
    readonly supersedenceKey?: string;
    readonly nowMs: () => number;
}

async function readSupersedenceDecision(
    { store, message, supersedenceKey = 'shared-topic', nowMs }: ReadSupersedenceDecisionInput
): Promise<ALOutboundComputedDto<ALOutboundTransportMessage>> {
    const read = await store.readOutgoingMessage({
        msg: message,
        planner: () => ({
            msg: message,
            dropReasonCode: undefined,
            persist: false,
            preparedMessages: [toALOutboundTransportMessage(message)],
            supersedenceTracking: { enabled: true, algo: 'latest-wins', key: supersedenceKey }
        }),
        observedCanonicalEntry: undefined,
        intent: 'enqueue'
    });
    return computeALOutboundDispatch({
        read,
        outboxEntry: { ...QueueBoxUtilities.toResourceEntryFromMsg(read.msg, 'WS_OUTBOX'), key: toALOutboundCanonicalKey(store.canonicalScope, read.msg) },
        dispatchAtMs: nowMs(),
        intent: 'enqueue',
        phase: 'immediate',
        options: {}
    });
}

interface CleanupStorageInput {
    readonly sql: PostgresSql;
    readonly namespace: string;
    readonly ownedKeys: readonly Key[];
}

interface RemainingStorageRow {
    readonly identity: string;
}

async function cleanupStorage({ sql, namespace, ownedKeys }: CleanupStorageInput): Promise<void> {
    // Every AL outbound work row this namespace owns shares one topic and resource id and differs
    // only by the effect id it carries in its context, so the namespace sweep is keyed on that
    // pair. It names an effect id only because the key builder takes one; the sweep ignores it,
    // which is what lets it reach terminal or malformed work no test kept a key for.
    const work = toALOutboundWorkKey(namespace, 'any-effect-id');
    for (const key of ownedKeys) {
        await sql`
            delete from resource_inbox
            where ri_topic_id = ${key.topicId} and ri_resource_id = ${key.resourceId}
                and fk_ext_bank_id = ${key.contextId}
        `;
        const remaining = await sql<RemainingStorageRow[]>`
            select ri_resource_id as identity from resource_inbox
            where ri_topic_id = ${key.topicId} and ri_resource_id = ${key.resourceId}
                and fk_ext_bank_id = ${key.contextId}
        `;
        expect(remaining).toEqual([]);
    }
    await sql`
        delete from resource_inbox
        where fk_ext_bank_id = ${namespace}
            or (ri_topic_id = ${work.topicId} and ri_resource_id = ${work.resourceId})
    `;
    await sql`delete from runtime_state_store where store_namespace = ${namespace}`;
    const remainingWork = await sql<RemainingStorageRow[]>`
        select ri_resource_id as identity from resource_inbox
        where fk_ext_bank_id = ${namespace}
            or (ri_topic_id = ${work.topicId} and ri_resource_id = ${work.resourceId})
    `;
    const remainingMetadata = await sql<RemainingStorageRow[]>`
        select store_key as identity from runtime_state_store where store_namespace = ${namespace}
    `;
    expect(remainingWork).toEqual([]);
    expect(remainingMetadata).toEqual([]);
}
