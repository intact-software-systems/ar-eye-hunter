import { decodePersistedALMessage } from '@shared/al-contracts/al-message-persistence-validation.ts';
import type { ALSessionInvalidationAuthority } from '@shared/alm/outbound/admission/al-session-invalidation-authority.ts';

import type { PSqlSql } from '../../../../postgres/p-sql-sql.ts';
import { ResourceInboxInvariantCorruptionError } from '../../../../queuebox/postgres/p-sql-resource-inbox-entry-repository.ts';
import { isExactAppOutboxInsert } from '../../../app-outbox/app-outbox-insert.ts';
import {
    computeWsOutboxProvenanceDigest,
    toWsOutboxProvenanceKey,
    WS_OUTBOX_PROVENANCE_NAMESPACE,
    type WsOutboxProvenance
} from '../../../websocket/outbox/ws-outbox-provenance.ts';
import type { AuthMutationComputed } from '../auth-mutation-contracts.ts';
import { toAuthLogoutOutbox } from './to-auth-logout-outbox.ts';

export interface AuthLogoutProvenanceInsert {
    readonly key: string;
    readonly value: string;
    readonly expiresAt: string;
    readonly queueKey: WsOutboxProvenance['queueKey'];
}

export async function computeAuthLogoutProvenance(
    computed: AuthMutationComputed
): Promise<AuthLogoutProvenanceInsert | null> {
    const write = computed.persistence.logoutOutbox;
    if (write === null) {
        return null;
    }
    if (
        computed.command.kind !== 'logout-session' || computed.read.kind !== 'logout-session' ||
        computed.read.bySession === null || computed.read.byToken === null
    ) {
        throw new TypeError('Logout proof requires the invalidated session');
    }
    const message = decodePersistedALMessage(write.entry.resource);
    if (!isExactAppOutboxInsert(toAuthLogoutOutbox(computed.command, message.id.senderId), write)) {
        throw new TypeError('Logout proof differs from the computed invalidation row');
    }
    const sessionInvalidation: ALSessionInvalidationAuthority = {
        kind: 'auth-session-invalidation',
        sessionId: computed.command.expected.sessionId,
        requestId: computed.command.requestId,
        invalidatedAtMs: computed.command.capturedAtEpochMs,
        issuedAtMs: computed.command.expected.issuedAtEpochMs,
        expiresAtMs: computed.command.expected.expiresAtEpochMs
    };
    const facts: Omit<WsOutboxProvenance, 'digest'> = {
        version: 1,
        producerKind: 'auth-session-invalidation',
        queueKey: write.entry.key,
        typeId: write.entry.typeId,
        messageId: message.id.msgId,
        senderId: message.id.senderId,
        expiresAtMs: sessionInvalidation.expiresAtMs,
        target: {
            kind: 'exact-invalidated-session',
            sessionInvalidation,
            admittedAudience: [sessionInvalidation.sessionId]
        }
    };
    const proof = { ...facts, digest: await computeWsOutboxProvenanceDigest(write.entry, facts) };
    return {
        key: toWsOutboxProvenanceKey(write.entry.key),
        value: JSON.stringify(proof),
        expiresAt: write.expiresAt,
        queueKey: write.entry.key
    };
}

export async function writeAuthLogoutProvenance(
    transaction: PSqlSql,
    write: AuthLogoutProvenanceInsert | null
): Promise<void> {
    if (write === null) {
        return;
    }
    const rows = await transaction<readonly { revision: number | string; }[]>`
        insert into runtime_state_store (store_namespace, store_key, store_value, expire_at_ts, updated_ts, revision)
        values (${WS_OUTBOX_PROVENANCE_NAMESPACE}, ${write.key}, ${write.value}, ${write.expiresAt}, now(), 0)
        on conflict (store_namespace, store_key) do nothing returning revision
    `;
    if (rows.length !== 1) {
        throw new ResourceInboxInvariantCorruptionError(write.queueKey, 'Auth logout provenance collision');
    }
}
