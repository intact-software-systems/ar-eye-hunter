import { decodeALMessage } from '@shared/al-contracts/al-message-persistence-validation.ts';
import { toALOrderingTrackKey } from '@shared/al-contracts/al-runtime.ts';
import { toALOutboundOrderingMessageKey } from '@shared/alm/outbound/admission/al-outbound-ordering-track-keys.ts';
import { EnqueuedType } from '@shared/api/api-config.ts';
import type { ResourceEntry } from '@shared/queuebox/ResourceEntry.ts';

import { PSqlFragment } from '../../postgres/p-sql-fragment.ts';

/**
 * The `(track, seq) → msgId` row the WS outbound admission store keeps for an ordered message, written by the
 * producer of an ordered `WS_OUTBOX` row beside that row, so the dequeue wait finds the row before its first dequeue.
 */
export interface AppOutboxTrackIndexRow {
    readonly namespace: string;
    readonly key: string;
    /** The stored value: the JSON string the admission store writes for the message id. */
    readonly value: string;
    readonly expiresAt: string;
}

export interface ComputeAppOutboxTrackIndexRowInput {
    readonly entry: ResourceEntry;
    readonly admissionNamespace: string;
    readonly expiresAt: string;
}

/** A `WS_OUTBOX` row whose message names `ordering.seq`; the full decode of its message is the dequeue's. */
export function isOrderedWsOutboxEntry(entry: ResourceEntry): boolean {
    return entry.typeId === EnqueuedType.WS_OUTBOX && toShallowOrderingSeq(entry.resource) !== undefined;
}

export function computeAppOutboxTrackIndexRow(input: ComputeAppOutboxTrackIndexRowInput): AppOutboxTrackIndexRow {
    const { entry, admissionNamespace, expiresAt } = input;
    if (!isOrderedWsOutboxEntry(entry)) {
        throw new TypeError('A track index row belongs to an ordered WS outbox row only');
    }
    const message = decodeALMessage(entry.resource).fold(
        (rejection) => {
            throw new TypeError(`An ordered WS outbox row carries no AL message: ${rejection.message}`);
        },
        (decoded) => decoded
    );
    const trackKey = toALOrderingTrackKey(message);
    const seq = message.ordering?.seq;
    if (trackKey === undefined || seq === undefined) {
        throw new TypeError('An ordered WS outbox row names no ordering track');
    }
    return {
        namespace: admissionNamespace,
        key: toALOutboundOrderingMessageKey(admissionNamespace, trackKey, seq),
        value: JSON.stringify(message.id.msgId),
        expiresAt
    };
}

/**
 * Insert-only: a live row already under the key is left as it is and returns nothing, which its caller reports;
 * an expired one is written over, one revision past it.
 */
export function toAppOutboxTrackIndexInsert(rows: readonly AppOutboxTrackIndexRow[]): PSqlFragment {
    const values = rows.map(({ namespace, key, value, expiresAt }) => ({ namespace, key, value, expiresAt }));
    return PSqlFragment.of`
        insert into runtime_state_store (store_namespace, store_key, store_value, expire_at_ts, updated_ts, revision)
        select indexed.namespace, indexed.key, indexed.value, indexed."expiresAt"::timestamptz, now(), 0
        from jsonb_to_recordset(${values}::jsonb) as indexed(namespace text, key text, value text, "expiresAt" text)
        on conflict (store_namespace, store_key) do update
            set store_value = excluded.store_value,
                expire_at_ts = excluded.expire_at_ts,
                updated_ts = now(),
                revision = runtime_state_store.revision + 1
            where runtime_state_store.expire_at_ts <= now()
        returning store_key`;
}

function toShallowOrderingSeq(resource: string): number | undefined {
    try {
        return decodeShallowOrderingSeq(JSON.parse(resource));
    }
    catch {
        return undefined;
    }
}

function decodeShallowOrderingSeq(value: unknown): number | undefined {
    return typeof value === 'object' && value !== null && 'ordering' in value
        ? decodeOrderingSeq(value.ordering)
        : undefined;
}

function decodeOrderingSeq(value: unknown): number | undefined {
    return typeof value === 'object' && value !== null && 'seq' in value && typeof value.seq === 'number'
        ? value.seq
        : undefined;
}
