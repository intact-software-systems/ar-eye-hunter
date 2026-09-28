import { decodePersistedALMessage } from '@shared/al-contracts/al-message-persistence-validation.ts';
import type { ClientPrincipalRef } from '@shared/api/client-types.ts';
import type { ResourceEntry } from '@shared/queuebox/ResourceEntry.ts';

import type { PSqlSql } from '../../../postgres/p-sql-sql.ts';
import { ResourceInboxInvariantCorruptionError } from '../../../queuebox/postgres/p-sql-resource-inbox-entry-repository.ts';
import { isExactAppOutboxInsert, type AppOutboxInsert } from '../../app-outbox/app-outbox-insert.ts';
import { computeClientStateSyncEntries } from '../../state-sync/state-sync-entry-computation.ts';
import {
    computeWsOutboxProvenanceDigest,
    toWsOutboxProvenanceKey,
    WS_OUTBOX_PROVENANCE_NAMESPACE,
    type WsOutboxProvenance
} from '../../websocket/outbox/ws-outbox-provenance.ts';
import type { ClientMutationComputed } from '../mutation/client-mutation-contracts.ts';

export interface ClientSnapshotProvenanceInsert {
    readonly queueKey: ResourceEntry['key'];
    readonly namespace: string;
    readonly key: string;
    readonly value: string;
    readonly expiresAt: string;
}

/** Prepares canonical mutation output; the AppInbox owner must validate the complete operation before writing. */
export async function computeClientSnapshotProvenance(
    mutation: ClientMutationComputed,
    senderId: string
): Promise<readonly ClientSnapshotProvenanceInsert[]> {
    if (mutation.outcome !== 'write') {
        return [];
    }
    const entries = mutation.stateSync.flatMap((sync) => computeClientStateSyncEntries(sync, senderId));
    if (entries.length !== mutation.outboxWrites.length) {
        throw new TypeError('Client snapshot outbox write set differs from accepted state sync');
    }
    const proofs: ClientSnapshotProvenanceInsert[] = [];
    for (const [index, entry] of entries.entries()) {
        const write = mutation.outboxWrites[index]!;
        if (
            !isExactAppOutboxInsert(entry, write) ||
            entry.audit.date.toString() !== write.entry.audit.date.toString() ||
            entry.audit.createdTs.toString() !== write.entry.audit.createdTs.toString() ||
            entry.audit.expiryTs.toString() !== write.entry.audit.expiryTs.toString()
        ) {
            throw new TypeError('Client snapshot outbox row differs from accepted state sync');
        }
        const proof = await computeClientSnapshotProvenanceInsert(
            write,
            mutation.snapshot.principal,
            mutation.principalAudienceSessionIds
        );
        if (proof !== null) {
            proofs.push(proof);
        }
    }
    return proofs;
}

async function computeClientSnapshotProvenanceInsert(
    write: AppOutboxInsert,
    principalRef: ClientPrincipalRef,
    principalAudienceSessionIds: readonly string[]
): Promise<ClientSnapshotProvenanceInsert | null> {
    const message = decodePersistedALMessage(write.entry.resource);
    const targets = message.targets;
    if (targets?.mode !== 'unicast' && !(targets?.mode === 'broadcast' && targets.scope === 'principal')) {
        return null;
    }
    if (
        targets.mode === 'broadcast' && (
            targets.principalRef?.applicationId !== principalRef.applicationId ||
            targets.principalRef.workspaceId !== principalRef.workspaceId ||
            targets.principalRef.principalId !== principalRef.principalId
        )
    ) {
        throw new TypeError('Client state-sync principal target differs from the accepted snapshot');
    }
    const facts: Omit<WsOutboxProvenance, 'digest'> = {
        version: 1,
        producerKind: 'state-sync',
        queueKey: write.entry.key,
        typeId: write.entry.typeId,
        messageId: message.id.msgId,
        senderId: message.id.senderId,
        expiresAtMs: write.entry.audit.expiryTs.epochMilliseconds,
        target: targets.mode === 'unicast'
            ? {
                kind: 'scoped-unicast',
                peerId: targets.toPeerId,
                scope: {
                    applicationId: principalRef.applicationId,
                    workspaceId: principalRef.workspaceId
                },
                admittedAudience: [targets.toPeerId]
            }
            : {
                kind: 'scoped-principal-broadcast',
                principalRef: {
                    applicationId: principalRef.applicationId,
                    workspaceId: principalRef.workspaceId,
                    principalId: principalRef.principalId
                },
                admittedAudience: principalAudienceSessionIds
            }
    };
    const proof: WsOutboxProvenance = {
        ...facts,
        digest: await computeWsOutboxProvenanceDigest(write.entry, facts)
    };
    return {
        queueKey: write.entry.key,
        namespace: WS_OUTBOX_PROVENANCE_NAMESPACE,
        key: toWsOutboxProvenanceKey(write.entry.key),
        value: JSON.stringify(proof),
        expiresAt: write.expiresAt
    };
}

export async function writeClientSnapshotProvenance(
    transaction: PSqlSql,
    writes: readonly ClientSnapshotProvenanceInsert[]
): Promise<void> {
    for (const write of writes) {
        const rows = await transaction<readonly { revision: number | string; }[]>`
            insert into runtime_state_store (store_namespace, store_key, store_value, expire_at_ts, updated_ts, revision)
            values (${write.namespace}, ${write.key}, ${write.value}, ${write.expiresAt}, now(), 0)
            on conflict (store_namespace, store_key) do nothing
            returning revision
        `;
        if (rows.length !== 1) {
            throw new ResourceInboxInvariantCorruptionError(
                write.queueKey,
                'Client snapshot provenance insert did not create exactly one row'
            );
        }
    }
}
