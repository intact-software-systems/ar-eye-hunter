import { decodePersistedALMessage } from '@shared/al-contracts/al-message-persistence-validation.ts';
import { EnqueuedType } from '@shared/api/api-config.ts';
import type { ResourceEntry } from '@shared/queuebox/ResourceEntry.ts';

import type { PSqlSql } from '../../../postgres/p-sql-sql.ts';
import { ResourceInboxInvariantCorruptionError } from '../../../queuebox/postgres/p-sql-resource-inbox-entry-repository.ts';
import {
    computeWsOutboxProvenanceDigest,
    toWsOutboxProvenanceKey,
    WS_OUTBOX_PROVENANCE_NAMESPACE,
    type WsOutboxProvenance
} from '../../websocket/outbox/ws-outbox-provenance.ts';
import type { GroupPresenceSummaryComputedWork } from './group-presence-summary-effects.ts';

export interface GroupDeltaProvenanceInsert {
    readonly queueKey: ResourceEntry['key'];
    readonly key: string;
    readonly value: string;
    readonly expiresAt: string;
}

/** The summary owner validates its complete computed rows before binding this proof. */
export async function computeGroupDeltaProvenance(
    computed: GroupPresenceSummaryComputedWork
): Promise<readonly GroupDeltaProvenanceInsert[]> {
    const proofs: GroupDeltaProvenanceInsert[] = [];
    for (const write of computed.downstreamOutboxWrites) {
        if (write.entry.typeId !== EnqueuedType.WS_OUTBOX) {
            continue;
        }
        const message = decodePersistedALMessage(write.entry.resource);
        const facts: Omit<WsOutboxProvenance, 'digest'> = {
            version: 1,
            producerKind: 'state-sync-snapshot',
            queueKey: write.entry.key,
            typeId: write.entry.typeId,
            messageId: message.id.msgId,
            senderId: message.id.senderId,
            expiresAtMs: write.entry.audit.expiryTs.epochMilliseconds,
            target: {
                kind: 'scoped-room-broadcast',
                groupRef: computed.work.aggregateRef,
                admittedAudience: computed.summary.summary.activeSessionIds
            }
        };
        proofs.push({
            queueKey: write.entry.key,
            key: toWsOutboxProvenanceKey(write.entry.key),
            value: JSON.stringify({ ...facts, digest: await computeWsOutboxProvenanceDigest(write.entry, facts) }),
            expiresAt: write.expiresAt
        });
    }
    return proofs;
}

export async function writeGroupDeltaProvenance(
    transaction: PSqlSql,
    proofs: readonly GroupDeltaProvenanceInsert[]
): Promise<void> {
    for (const proof of proofs) {
        const rows = await transaction<readonly { revision: number | string; }[]>`
            insert into runtime_state_store (store_namespace, store_key, store_value, expire_at_ts, updated_ts, revision)
            values (${WS_OUTBOX_PROVENANCE_NAMESPACE}, ${proof.key}, ${proof.value}, ${proof.expiresAt}, now(), 0)
            on conflict (store_namespace, store_key) do nothing
            returning revision
        `;
        if (rows.length !== 1) {
            throw new ResourceInboxInvariantCorruptionError(
                proof.queueKey,
                'Group delta provenance insert did not create exactly one row'
            );
        }
    }
}
