import { Temporal } from '@js-temporal/polyfill';
import {
    describe,
    expect,
    it
} from 'vitest';

import { toDomain } from '@shared-server/queuebox/postgres/resource-inbox-row-codec.ts';
import {
    computeWsOutboxProvenanceDigest,
    toWsOutboxProvenanceKey,
    WS_OUTBOX_PROVENANCE_NAMESPACE,
    WsOutboxProvenanceReader,
    type WsOutboxProvenance
} from '@shared-server/rallar-system/websocket/outbox/ws-outbox-provenance.ts';
import { newALUnicastMessage } from '@shared/al-contracts/al-contract.ts';
import { ALAdmissionCorruptionError } from '@shared/alm/al-admission-decoder.ts';
import { EnqueuedType } from '@shared/api/api-config.ts';
import { EntityStatus } from '@shared/queuebox/ResourceEntry.ts';
import { QueueBoxUtilities } from '@shared/services/queue-box-utilities.ts';

import { FakeRuntimeStateRepository } from '../../../runtime-state/test-support/fake-runtime-state-repository.ts';

describe('row-bound WS producer provenance', () => {
    it('encodes every queue key component injectively', () => {
        const keys = [
            { topicId: 'a/b', resourceId: 'c', contextId: 'd' },
            { topicId: 'a', resourceId: 'b/c', contextId: 'd' },
            { topicId: 'a', resourceId: 'b', contextId: 'c/d' },
            { topicId: '', resourceId: '%2F', contextId: 'null' },
            { topicId: 'null', resourceId: '/', contextId: '' }
        ].map(toWsOutboxProvenanceKey);
        expect(new Set(keys).size).toBe(5);
        expect(keys[0]).toBe('v1:["a/b","c","d"]');
    });

    it.each([{ audience: ['peer'] }, { audience: [] }])('preserves frozen audience $audience and ignores mutable queue metadata', async ({ audience }) => {
        const fixture = await createFixture(audience);
        const entry = {
            ...fixture.entry,
            status: EntityStatus.RESERVED,
            dequeueAudit: { attempts: 7, startTs: Temporal.Now.instant() },
            db: { id: 'database-id' }
        };
        expect(await fixture.reader.readProducerProvenance(fixture.message, entry))
            .toEqual({ admittedAudience: audience, recipientScope: { applicationId: 'app', workspaceId: 'workspace' } });
    });

    it.each(['missing', 'malformed', 'version', 'producer', 'key', 'message', 'target', 'scope', 'digest', 'expired'] as const)(
        'rejects %s provenance even when the row otherwise matches',
        async (corruption) => {
            const fixture = await createFixture(['peer']);
            const proof = { ...fixture.proof };
            if (corruption === 'missing') {
                await fixture.repository.deleteByKey(WS_OUTBOX_PROVENANCE_NAMESPACE, fixture.key);
            }
            else {
                const value = corruption === 'malformed' ? '{}' : JSON.stringify({
                    ...proof,
                    ...(corruption === 'version' ? { version: 2 } : {}),
                    ...(corruption === 'producer' ? { producerKind: 'arbitrary' } : {}),
                    ...(corruption === 'key' ? { queueKey: { ...proof.queueKey, contextId: 'wrong' } } : {}),
                    ...(corruption === 'message' ? { messageId: 'another-message' } : {}),
                    ...(corruption === 'target' ? { target: { ...proof.target, peerId: 'another-peer' } } : {}),
                    ...(corruption === 'scope' ? { target: { ...proof.target, scope: { applicationId: 'app' } } } : {}),
                    ...(corruption === 'digest' ? { digest: '0'.repeat(64) } : {}),
                    ...(corruption === 'expired' ? { expiresAtMs: 1 } : {})
                });
                await fixture.repository.upsert(WS_OUTBOX_PROVENANCE_NAMESPACE, fixture.key, value, proof.expiresAtMs);
            }
            await expect(fixture.reader.readProducerProvenance(fixture.message, fixture.entry)).rejects.toBeInstanceOf(ALAdmissionCorruptionError);
        }
    );

    it.each(['resource', 'type', 'createdBy', 'createdTs', 'date', 'expiry'] as const)('binds immutable row %s', async (field) => {
        const fixture = await createFixture(['peer']);
        const entry = {
            ...fixture.entry,
            ...(field === 'resource' ? { resource: `${fixture.entry.resource} ` } : {}),
            ...(field === 'type' ? { typeId: 'OTHER' } : {}),
            audit: {
                ...fixture.entry.audit,
                ...(field === 'createdBy' ? { createdBy: 'another-owner' } : {}),
                ...(field === 'createdTs' ? { createdTs: fixture.entry.audit.createdTs.add({ nanoseconds: 1 }) } : {}),
                ...(field === 'date' ? { date: fixture.entry.audit.date.add({ nanoseconds: 1 }) } : {}),
                ...(field === 'expiry' ? { expiryTs: fixture.entry.audit.expiryTs.add({ milliseconds: 1 }) } : {})
            }
        };
        await expect(fixture.reader.readProducerProvenance(fixture.message, entry)).rejects.toBeInstanceOf(ALAdmissionCorruptionError);
    });

    it('rejects independently invalid target identity even with a recomputed digest', async () => {
        const fixture = await createFixture(['peer']);
        const candidate = { ...fixture.proof, target: { ...fixture.proof.target, peerId: 'wrong-peer', admittedAudience: ['wrong-peer'] } };
        const proof = { ...candidate, digest: await computeWsOutboxProvenanceDigest(fixture.entry, candidate) };
        await fixture.repository.upsert(WS_OUTBOX_PROVENANCE_NAMESPACE, fixture.key, JSON.stringify(proof), proof.expiresAtMs);
        await expect(fixture.reader.readProducerProvenance(fixture.message, fixture.entry)).rejects.toBeInstanceOf(ALAdmissionCorruptionError);
    });

    it('round-trips epoch-millisecond producer audit facts through the PostgreSQL row codec', async () => {
        const fixture = await createFixture(['peer']);
        const createdTs = Temporal.Instant.fromEpochMilliseconds(Date.now()).toZonedDateTimeISO('UTC').toPlainDateTime();
        const entry = { ...fixture.entry, audit: { ...fixture.entry.audit, createdTs, date: createdTs.toPlainTime() } };
        const proof = { ...fixture.proof, digest: await computeWsOutboxProvenanceDigest(entry, fixture.proof) };
        await fixture.repository.upsert(WS_OUTBOX_PROVENANCE_NAMESPACE, fixture.key, JSON.stringify(proof), proof.expiresAtMs);
        const decoded = toDomain({
            ri_row_id: 1n,
            ri_resource_id: entry.key.resourceId,
            ri_topic_id: entry.key.topicId,
            fk_ext_bank_id: entry.key.contextId,
            ri_resource: entry.resource,
            ri_type_id: entry.typeId,
            ri_status: 'RESERVED',
            ri_attempts: 4n,
            system_date: createdTs.toPlainDate().toString(),
            created_by: entry.audit.createdBy,
            created_ts: createdTs.toString({ fractionalSecondDigits: 6 }),
            expire_ts: entry.audit.expiryTs.toZonedDateTimeISO('UTC').toPlainDateTime().toString({ fractionalSecondDigits: 6 }),
            start_ts: null,
            end_ts: null,
            next_ts: null
        });
        expect(await fixture.reader.readProducerProvenance(fixture.message, decoded))
            .toEqual({ admittedAudience: ['peer'], recipientScope: { applicationId: 'app', workspaceId: 'workspace' } });
    });
});

async function createFixture(admittedAudience: readonly string[]) {
    const message = newALUnicastMessage('server', { topicId: 'snapshot', contextId: 'request', resourceId: 'page' }, 'peer', 'snapshot.v1', {}, {
        ttlMs: 30_000
    });
    const entry = QueueBoxUtilities.toResourceEntryFromMsg(message, EnqueuedType.WS_OUTBOX);
    const facts: Omit<WsOutboxProvenance, 'digest'> = {
        version: 1,
        producerKind: 'state-sync',
        queueKey: entry.key,
        typeId: entry.typeId,
        messageId: message.id.msgId,
        senderId: message.id.senderId,
        expiresAtMs: entry.audit.expiryTs.epochMilliseconds,
        target: { kind: 'scoped-unicast', peerId: 'peer', scope: { applicationId: 'app', workspaceId: 'workspace' }, admittedAudience }
    };
    const proof = { ...facts, digest: await computeWsOutboxProvenanceDigest(entry, facts) };
    const repository = new FakeRuntimeStateRepository();
    const key = toWsOutboxProvenanceKey(entry.key);
    await repository.upsert(WS_OUTBOX_PROVENANCE_NAMESPACE, key, JSON.stringify(proof), proof.expiresAtMs);
    const reader = new WsOutboxProvenanceReader({ repository, nowMs: () => Date.now() });
    return { message, entry, proof, repository, reader, key };
}
