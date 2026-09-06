import { Temporal } from '@js-temporal/polyfill';
import { describe, expect, it, onTestFinished } from 'vitest';

import { PSqlOutboundAdmissionBackend } from '@shared-server/al-runtime/postgres/p-sql-outbound-admission-backend.ts';
import { newALUnicastMessage, type ALMessage } from '@shared/al-contracts/al-contract.ts';
import { normalizeALRuntimeStoreRetention } from '@shared/alm/ALStoreRetention.ts';
import { createALOutboundAdmissionStore, type ALOutboundAdmissionStore } from '@shared/alm/outbound/al-outbound-admission-store.ts';
import { decodeALOutboundPreparedMessage } from '@shared/alm/outbound/al-outbound-effect-validation.ts';
import { computeALOutboundDispatch } from '@shared/alm/outbound/compute-al-outbound-dispatch.ts';
import {
    DequeueResourceEntryController,
    NonRetryableException,
    ResilienceDto,
    ResourceInboxHandlerEntryError
} from '@shared/queuebox/DequeueResourceEntryController.ts';
import { EntityStatus, NEVER_EXPIRE_TS, type ResourceEntry } from '@shared/queuebox/ResourceEntry.ts';
import { CircuitBreakerPolicy } from '@shared/resilience/circuit-breaker.ts';

import {
    createRuntimeStatePostgresSql,
    requirePostgresDatabaseUrl
} from '../../runtime-state/postgres/postgres-runtime-state-client-fixtures.ts';

const postgresIt = process.env.RALLAR_POSTGRES_INTEGRATION === '1' ? it : it.skip;

describe('Postgres atomic AL admission and QueueBox work', () => {
    postgresIt('keeps non-retryable work out of normal, failed, timeout and exhaustion recovery claims', async () => {
        const { backend, other, entry } = await createStorage();
        const dueAt = Temporal.Now.instant().subtract({ seconds: 10 });
        await backend.workQueue.enqueue({
            ...entry,
            status: EntityStatus.RETRY,
            dequeueAudit: { attempts: 19, startTs: dueAt, endTs: dueAt, nextTs: dueAt }
        });
        const duration = Temporal.Duration.from({ seconds: 10 });
        const resilience = ResilienceDto.toResilienceDto(new CircuitBreakerPolicy(10, duration, duration, duration), 1, 10, 1, 1);
        const types = new Set([entry.typeId]);
        const controller = DequeueResourceEntryController.toDequeuer<string>(
            backend.workQueue,
            () => types,
            () => 1,
            20,
            10,
            resilience
        );

        await controller.dequeueForCompute(async () => {
            throw new NonRetryableException('Malformed persisted message');
        });

        expect(await other.workQueue.getItem(entry.key)).toMatchObject({
            status: EntityStatus.NON_RETRYABLE,
            dequeueAudit: { attempts: 20, nextTs: undefined }
        });
        const reservation = { maxToReserve: 1, maxAttempts: 21 };
        expect(
            await other.workQueue.reserveEntries(
                types,
                new Set([EntityStatus.NEW, EntityStatus.RETRY, EntityStatus.FAILED]),
                reservation
            )
        ).toEqual(new Map());
        expect(await other.workQueue.reserveTimeoutEntries(types, reservation, Temporal.Duration.from({ milliseconds: 0 })))
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
        const resilience = ResilienceDto.toResilienceDto(new CircuitBreakerPolicy(10, duration, duration, duration), 1, 10, 1, 1);
        const controller = DequeueResourceEntryController.toDequeuer<string>(
            backend.workQueue,
            () => new Set([entry.typeId]),
            () => 1,
            20,
            10,
            resilience
        );
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
        const { backend, other, entry } = await createStorage();
        const settings = {
            namespace: entry.key.contextId,
            supersedenceTrackTtlMs: 60_000,
            retention: normalizeALRuntimeStoreRetention()
        };
        const first = createALOutboundAdmissionStore({ ...settings, backend });
        const second = createALOutboundAdmissionStore({ ...settings, backend: other });
        const older = createSupersedingMessage('sender-a', 1);
        const newer = createSupersedingMessage('sender-b', 2);
        const oldDecision = await readSupersedenceDecision(first, older);
        const newDecision = await readSupersedenceDecision(second, newer);

        expect(await second.commitBundle(newDecision.bundle!, decodeALOutboundPreparedMessage)).toBe('committed');
        expect(await first.commitBundle(oldDecision.bundle!, decodeALOutboundPreparedMessage)).toBe('conflict');
        expect(await first.getSentMessage(older.id.msgId)).toBeUndefined();
        const pending = await first.claimReadyEffects({ maxCount: 10 }, decodeALOutboundPreparedMessage);
        expect(pending.map((work) => work.payload.kind === 'send-prepared' ? work.payload.msg.id.msgId : '')).toEqual([newer.id.msgId]);
        const retried = await readSupersedenceDecision(first, older);
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
        const reserved = await other.workQueue.reserveEntries(new Set([entry.typeId]), new Set([EntityStatus.NEW]), 1);
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
            await other.workQueue.reserveEntries(new Set([entry.typeId]), new Set([EntityStatus.NEW]), 1);
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
        const [old] = (await backend.workQueue.reserveEntries(new Set([entry.typeId]), new Set([EntityStatus.NEW]), 1)).values();
        await backend.workQueue.releaseEntries([old], { status: EntityStatus.COMPLETED, delayMs: null });
        await other.workQueue.enqueue({ ...entry, resource: 'later-work' });
        const [current] = (await other.workQueue.reserveEntries(new Set([entry.typeId]), new Set([EntityStatus.NEW]), 1)).values();
        expect(old.dequeueAudit.attempts).toBe(current.dequeueAudit.attempts);
        await expect(backend.workQueue.releaseEntries([old], { status: EntityStatus.COMPLETED, delayMs: null }))
            .rejects.toMatchObject({ code: 'resource-inbox-lost-reservation' });
        expect(await other.workQueue.getItem(entry.key)).toEqual(current);
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

async function createStorage() {
    const namespace = crypto.randomUUID();
    const sql = await createRuntimeStatePostgresSql(requirePostgresDatabaseUrl());
    onTestFinished(async () => {
        try {
            await sql`delete from resource_inbox where fk_ext_bank_id = ${namespace}`;
            await sql`delete from runtime_state_store where store_namespace = ${namespace}`;
        }
        finally {
            await sql.end();
        }
    });
    const otherSql = await createRuntimeStatePostgresSql(requirePostgresDatabaseUrl());
    onTestFinished(() => otherSql.end());
    return {
        backend: new PSqlOutboundAdmissionBackend(sql, namespace),
        other: new PSqlOutboundAdmissionBackend(otherSql, namespace),
        entry: createEntry(namespace)
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
        { sequence }
    );
    return { ...message, ordering: { seq: sequence, orderingKey: 'shared-topic' } };
}

async function readSupersedenceDecision(store: ALOutboundAdmissionStore, message: ALMessage) {
    const read = await store.readOutgoingMessage(message, () => ({
        persist: false,
        preparedMessages: [message],
        supersedenceTracking: { enabled: true, algo: 'latest-wins', key: 'shared-topic' }
    }));
    return computeALOutboundDispatch({
        read,
        outboxEntry: undefined,
        canFallback: false,
        dispatchAtMs: Date.now(),
        intent: 'enqueue',
        phase: 'immediate',
        options: {}
    });
}
