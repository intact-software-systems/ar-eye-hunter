import { decodePersistedALMessage } from '@shared/al-contracts/al-message-persistence-validation.ts';
import { isSameGroupRef } from '@shared/api/api-type-utils.ts';
import type { Key } from '@shared/queuebox/ResourceEntry.ts';

import type { PSqlSql } from '../../../postgres/p-sql-sql.ts';
import { ResourceInboxInvariantCorruptionError } from '../../../queuebox/postgres/p-sql-resource-inbox-entry-repository.ts';
import type { AppOutboxInsert } from '../../app-outbox/app-outbox-insert.ts';
import {
    computeWsOutboxProvenanceDigest,
    toWsOutboxProvenanceKey,
    WS_OUTBOX_PROVENANCE_NAMESPACE,
    type WsOutboxProvenance
} from '../../websocket/outbox/ws-outbox-provenance.ts';
import type { RtcTopologyPublication } from './rtc-topology-publication.ts';
import { assertRtcTopologyPublicationOutbox } from './rtc-topology-ws-outbox-entry.ts';

export interface RtcTopologyOutboxProvenanceInsert {
    readonly queueKey: Key;
    readonly key: string;
    readonly value: string;
    readonly expiresAt: string;
}

export async function computeRtcTopologyOutboxProvenance(
    publication: RtcTopologyPublication,
    outboxWrites: readonly AppOutboxInsert[]
): Promise<readonly RtcTopologyOutboxProvenanceInsert[]> {
    assertRtcTopologyPublicationOutbox(publication, outboxWrites.map((write) => write.entry));
    const proofs: RtcTopologyOutboxProvenanceInsert[] = [];
    for (const write of outboxWrites) {
        const message = decodePersistedALMessage(write.entry.resource);
        const targets = message.targets;
        if (
            targets?.mode !== 'broadcast' || targets.scope !== 'room' || !targets.groupRef ||
            !isSameGroupRef(targets.groupRef, publication.groupRef) || !targets.recipientPeerIds ||
            targets.recipientPeerIds.some((sessionId) => !publication.recipientSessionIds.includes(sessionId))
        ) {
            throw new TypeError('RTC topology page differs from its validated publication audience');
        }
        const facts: Omit<WsOutboxProvenance, 'digest'> = {
            version: 1,
            producerKind: 'rtc-topology',
            queueKey: write.entry.key,
            typeId: write.entry.typeId,
            messageId: message.id.msgId,
            senderId: message.id.senderId,
            expiresAtMs: write.entry.audit.expiryTs.epochMilliseconds,
            target: {
                kind: 'scoped-room-broadcast',
                groupRef: publication.groupRef,
                admittedAudience: targets.recipientPeerIds
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

export async function writeRtcTopologyOutboxProvenance(
    transaction: PSqlSql,
    proofs: readonly RtcTopologyOutboxProvenanceInsert[]
): Promise<void> {
    for (const proof of proofs) {
        const rows = await transaction<readonly { revision: number | string; }[]>`
            insert into runtime_state_store (store_namespace, store_key, store_value, expire_at_ts, updated_ts, revision)
            values (${WS_OUTBOX_PROVENANCE_NAMESPACE}, ${proof.key}, ${proof.value}, ${proof.expiresAt}, now(), 0)
            on conflict (store_namespace, store_key) do nothing returning revision
        `;
        if (rows.length !== 1) {
            throw new ResourceInboxInvariantCorruptionError(proof.queueKey, 'RTC topology provenance collision');
        }
    }
}
