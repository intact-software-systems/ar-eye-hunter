import { decodeALMessage } from '@shared/al-contracts/al-message-persistence-validation.ts';
import { toALOrderingTrackKey } from '@shared/al-contracts/al-runtime.ts';
import { toALOutboundOrderingMessageKey } from '@shared/alm/outbound/admission/al-outbound-ordering-track-keys.ts';
import { EnqueuedType } from '@shared/api/api-config.ts';
import type { ResourceEntry } from '@shared/queuebox/ResourceEntry.ts';

import type { AppOutboxSidecarRow } from './app-outbox-sidecar.ts';

export interface ComputeAppOutboxTrackIndexRowInput {
    readonly entry: ResourceEntry;
    readonly admissionNamespace: string;
    readonly expiresAt: string;
}

/** A `WS_OUTBOX` row whose message names `ordering.seq`; the full decode of its message is the dequeue's. */
export function isOrderedWsOutboxEntry(entry: ResourceEntry): boolean {
    return entry.typeId === EnqueuedType.WS_OUTBOX && toShallowOrderingSeq(entry.resource) !== undefined;
}

/**
 * The `(track, seq) → msgId` row the WS outbound admission store keeps for an ordered message, written by the
 * producer of an ordered `WS_OUTBOX` row beside that row, so the dequeue wait finds the row before its first dequeue;
 * its value is the JSON string the admission store writes for the message id.
 */
export function computeAppOutboxTrackIndexRow(input: ComputeAppOutboxTrackIndexRowInput): AppOutboxSidecarRow {
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
