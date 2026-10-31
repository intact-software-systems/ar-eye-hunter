import { Temporal } from '@js-temporal/polyfill';
import type { ResourceEntry } from '@shared/queuebox/ResourceEntry.ts';

import type { PSqlSql } from '../../../postgres/p-sql-sql.ts';
import { ResourceInboxInvariantCorruptionError } from '../../../queuebox/postgres/p-sql-resource-inbox-entry-repository.ts';
import type {
    RuntimeStateGuardedBatchEffect,
    RuntimeStateGuardedBatchEffectResult
} from '../../../runtime-state/guarded-batch/runtime-state-guarded-batch.ts';
import {
    computeWsOutboxProvenanceRecord,
    WS_OUTBOX_PROVENANCE_NAMESPACE
} from '../../websocket/outbox/ws-outbox-provenance.ts';
import type {
    ClientMutationComputed,
    ClientMutationDomainAppliedWrite,
    ClientMutationOutboxWrite
} from '../mutation/client-mutation-contracts.ts';

export interface ClientSnapshotProvenanceInsert {
    readonly queueKey: ResourceEntry['key'];
    readonly namespace: string;
    readonly key: string;
    readonly value: string;
    readonly expiresAt: string;
}

/** Prepares canonical mutation output; the AppInbox owner must validate the complete operation before writing. */
export function computeClientSnapshotProvenance(
    mutation: ClientMutationComputed
): readonly ClientSnapshotProvenanceInsert[] {
    if (mutation.outcome !== 'write') {
        return [];
    }
    return mutation.outbox.flatMap((outboxWrite) => {
        const proof = computeClientSnapshotProvenanceInsert(outboxWrite, mutation);
        return proof === null ? [] : [proof];
    });
}

function computeClientSnapshotProvenanceInsert(
    { write, message }: ClientMutationOutboxWrite,
    mutation: ClientMutationDomainAppliedWrite
): ClientSnapshotProvenanceInsert | null {
    const principalRef = mutation.snapshot.principal;
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
    const record = computeWsOutboxProvenanceRecord({
        producerKind: 'state-sync',
        entry: write.entry,
        message,
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
                admittedAudience: mutation.principalAudienceSessionIds
            }
    });
    return {
        queueKey: write.entry.key,
        namespace: WS_OUTBOX_PROVENANCE_NAMESPACE,
        key: record.key,
        value: record.value,
        expiresAt: write.expiresAt
    };
}

/** The proof's insert as a guarded-batch effect; the row expires at the proof's own millisecond expiry. */
export function toClientSnapshotProvenanceEffect(
    insert: ClientSnapshotProvenanceInsert
): RuntimeStateGuardedBatchEffect {
    return {
        effectId: toClientSnapshotProvenanceEffectId(insert),
        operation: 'insert',
        namespace: insert.namespace,
        key: insert.key,
        value: insert.value,
        expireAtTimestamp: Temporal.Instant.from(insert.expiresAt).epochMilliseconds
    };
}

/** A proof that did not create its row is the same corruption the standalone insert reports. */
export function requireClientSnapshotProvenanceApplied(
    results: readonly RuntimeStateGuardedBatchEffectResult[],
    inserts: readonly ClientSnapshotProvenanceInsert[]
): void {
    for (const insert of inserts) {
        const effectId = toClientSnapshotProvenanceEffectId(insert);
        if (results.find((result) => result.effectId === effectId)?.status !== 'applied') {
            throw new ResourceInboxInvariantCorruptionError(
                insert.queueKey,
                'Client snapshot provenance insert did not create exactly one row'
            );
        }
    }
}

function toClientSnapshotProvenanceEffectId(insert: ClientSnapshotProvenanceInsert): string {
    return `provenance:${insert.key}`;
}

export async function writeClientSnapshotProvenance(
    transaction: PSqlSql,
    writes: readonly ClientSnapshotProvenanceInsert[]
): Promise<void> {
    for (const write of writes) {
        const rows = await transaction<readonly { revision: number | string; }[]>`
            insert into runtime_state_store (store_namespace, store_key, store_value, expire_at_ts, updated_ts, revision)
            values (${write.namespace}, ${write.key}, ${write.value}, ${write.expiresAt}, now(), 0)
            on conflict (store_namespace, store_key) do update
                set store_value = excluded.store_value,
                    expire_at_ts = excluded.expire_at_ts,
                    updated_ts = now(),
                    revision = runtime_state_store.revision + 1
                where runtime_state_store.expire_at_ts <= now()
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
