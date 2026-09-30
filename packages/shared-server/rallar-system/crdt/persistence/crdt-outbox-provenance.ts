import type { ALMessage } from '@shared/al-contracts/al-contract.ts';
import { decodePersistedALMessage } from '@shared/al-contracts/al-message-persistence-validation.ts';
import { EnqueuedType } from '@shared/api/api-config.ts';
import { isSameGroupRef } from '@shared/api/api-type-utils.ts';
import { DEFAULT_STATE_WORKSPACE_ID } from '@shared/api/state-types.ts';
import {
    RALLAR_CRDT_APPEND_RESPONSE_TYPE_ID,
    RALLAR_CRDT_UPDATE_TYPE_ID
} from '@shared/crdt/mod.ts';
import type { Key } from '@shared/queuebox/ResourceEntry.ts';

import type { PSqlSql } from '../../../postgres/p-sql-sql.ts';
import { ResourceInboxInvariantCorruptionError } from '../../../queuebox/postgres/p-sql-resource-inbox-entry-repository.ts';
import {
    computeWsOutboxProvenanceDigest,
    toWsOutboxProvenanceKey,
    WS_OUTBOX_PROVENANCE_NAMESPACE,
    type WsOutboxProvenance
} from '../../websocket/outbox/ws-outbox-provenance.ts';
import type {
    CrdtAppendCommand,
    CrdtMutationComputed,
    CrdtMutationPublicationAuthority
} from '../mutation/crdt-mutation-contracts.ts';

export interface CrdtOutboxProvenanceInsert {
    readonly queueKey: Key;
    readonly key: string;
    readonly value: string;
    readonly expiresAt: string;
}

export async function computeCrdtOutboxProvenance(
    mutation: CrdtMutationComputed
): Promise<readonly CrdtOutboxProvenanceInsert[]> {
    const wsWrites = mutation.outboxWrites.filter((write) => write.entry.typeId === EnqueuedType.WS_OUTBOX);
    if (wsWrites.length === 0) {
        return [];
    }
    const authority = mutation.read.publicationAuthority;
    if (mutation.command.operation !== 'append' || authority === null) {
        throw new TypeError('CRDT WS publication requires the authorized append scope and audience');
    }
    const document = mutation.command.document;
    if (
        authority.recipientScope.applicationId !== document.applicationId ||
        authority.recipientScope.workspaceId !== (document.workspaceId ?? DEFAULT_STATE_WORKSPACE_ID) ||
        !authority.admittedAudience.includes(mutation.command.actor.sessionId)
    ) {
        throw new TypeError('CRDT publication authority differs from the authorized document or actor session');
    }

    const proofs: CrdtOutboxProvenanceInsert[] = [];
    for (const write of wsWrites) {
        const message = decodePersistedALMessage(write.entry.resource);
        const facts: Omit<WsOutboxProvenance, 'digest'> = {
            version: 1,
            producerKind: 'crdt',
            queueKey: write.entry.key,
            typeId: write.entry.typeId,
            messageId: message.id.msgId,
            senderId: message.id.senderId,
            expiresAtMs: write.entry.audit.expiryTs.epochMilliseconds,
            target: toCrdtOutboxProvenanceTarget(mutation.command, message, authority)
        };
        proofs.push({
            queueKey: write.entry.key,
            key: toWsOutboxProvenanceKey(write.entry.key),
            value: JSON.stringify({
                ...facts,
                digest: await computeWsOutboxProvenanceDigest(write.entry, facts)
            }),
            expiresAt: write.expiresAt
        });
    }
    return proofs;
}

function toCrdtOutboxProvenanceTarget(
    command: CrdtAppendCommand,
    message: ALMessage,
    authority: CrdtMutationPublicationAuthority
): WsOutboxProvenance['target'] {
    const targets = message.targets;
    if (message.payload.typeId === RALLAR_CRDT_APPEND_RESPONSE_TYPE_ID) {
        if (targets?.mode !== 'unicast' || targets.toPeerId !== command.actor.sessionId) {
            throw new TypeError('CRDT reply target differs from its authenticated sender session');
        }
        return {
            kind: 'scoped-unicast',
            peerId: command.actor.sessionId,
            scope: authority.recipientScope,
            admittedAudience: [command.actor.sessionId]
        };
    }
    if (message.payload.typeId !== RALLAR_CRDT_UPDATE_TYPE_ID) {
        throw new TypeError('CRDT WS outbox row has an unsupported publication effect');
    }
    if (command.document.scope === 'room' && command.document.roomRef) {
        if (
            targets?.mode !== 'broadcast' || targets.scope !== 'room' ||
            !targets.groupRef || !isSameGroupRef(targets.groupRef, command.document.roomRef)
        ) {
            throw new TypeError('CRDT room fanout differs from the authorized room');
        }
        return {
            kind: 'scoped-room-broadcast',
            groupRef: command.document.roomRef,
            admittedAudience: authority.admittedAudience
        };
    }
    if (command.document.scope === 'principal' && command.document.principalId) {
        if (targets?.mode !== 'unicast' || targets.toPeerId !== command.document.principalId) {
            throw new TypeError('CRDT principal fanout differs from the authorized principal');
        }
        return {
            kind: 'scoped-principal-unicast',
            peerId: command.document.principalId,
            principalRef: { ...authority.recipientScope, principalId: command.document.principalId },
            admittedAudience: authority.admittedAudience
        };
    }
    if (command.document.scope === 'app' && targets?.mode === 'broadcast' && targets.scope === 'world') {
        return { kind: 'scoped-world-broadcast', scope: authority.recipientScope };
    }
    throw new TypeError('CRDT fanout target differs from its authorized document');
}

export async function writeCrdtOutboxProvenance(
    transaction: PSqlSql,
    proofs: readonly CrdtOutboxProvenanceInsert[]
): Promise<void> {
    for (const proof of proofs) {
        const rows = await transaction<readonly { revision: number | string; }[]>`
            insert into runtime_state_store (store_namespace, store_key, store_value, expire_at_ts, updated_ts, revision)
            values (${WS_OUTBOX_PROVENANCE_NAMESPACE}, ${proof.key}, ${proof.value}, ${proof.expiresAt}, now(), 0)
            on conflict (store_namespace, store_key) do nothing returning revision
        `;
        if (rows.length !== 1) {
            throw new ResourceInboxInvariantCorruptionError(proof.queueKey, 'CRDT provenance collision');
        }
    }
}
