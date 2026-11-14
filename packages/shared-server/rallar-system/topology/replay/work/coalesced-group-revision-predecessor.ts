import { NEVER_EXPIRE_TS, type ResourceEntry } from '@shared/queuebox/ResourceEntry.ts';
import { decodeRtcTopologyWorkEntry } from '@shared/queuebox/rtc-topology-work-entry-contract.ts';

import { AppOutboxType } from '../../../app-outbox/app-outbox-type.ts';
import {
    COALESCED_APP_OUTBOX_WORK_FIELD,
    tryReadCoalescedAppOutboxWorkEnvelope,
    type CoalescedAppOutboxWorkEnvelope
} from '../../../app-outbox/coalesced-app-outbox-work.ts';
import type { RtcTopologyGroupRevisionWork } from '../../mutation/rtc-topology-outbox-entry.ts';
import { readRtcTopologyWorkEnvelope } from './rtc-topology-work-codec.ts';

export interface CoalescedMessageIdentity {
    readonly senderId: string;
    readonly tsEpochMs: number;
    /** A stored message without an expiry constraint never expires. */
    readonly expiresAtEpochMs: number;
}

export interface PreviousCoalescedGroupRevisionWork {
    readonly envelope: CoalescedAppOutboxWorkEnvelope<RtcTopologyGroupRevisionWork>;
    readonly messageIdentity: CoalescedMessageIdentity;
}

export interface CurrentCoalescedGroupRevisionPredecessor {
    readonly kind: 'current';
    readonly entry: ResourceEntry;
    readonly work: PreviousCoalescedGroupRevisionWork;
}

/** Of a head stamped with an unsupported envelope version, only the coalescing generation the compare-and-set guards is read. */
export interface UnsupportedCoalescedGroupRevisionPredecessor {
    readonly kind: 'unsupported';
    readonly entry: ResourceEntry;
    readonly generation: number;
}

export type CoalescedGroupRevisionPredecessor =
    | CurrentCoalescedGroupRevisionPredecessor
    | UnsupportedCoalescedGroupRevisionPredecessor;

/**
 * The stored head as a writer may use it; anything that is neither current coalesced work nor an unsupported envelope
 * version with a coalescing generation is corrupt and fails closed.
 *
 * A stored coalesced row never rewrites its created-audit columns — both the
 * pending merge and the terminal revival compare-and-set update the resource,
 * lifecycle and expiry only. Every later generation must therefore keep the
 * original message sender and creation identity, and carry the expiry it writes
 * in both the message and the audit, or the row stops satisfying the canonical
 * work contract that release idempotency checks. The latest request and due
 * times live in the coalesced metadata, not the message identity.
 */
export function decodeCoalescedGroupRevisionPredecessor(entry: ResourceEntry): CoalescedGroupRevisionPredecessor {
    try {
        const decoded = decodeRtcTopologyWorkEntry(entry);
        if (decoded.left?.code === 'unsupported') {
            return { kind: 'unsupported', entry, generation: decodeUnsupportedCoalescedGeneration(entry) };
        }
        if (decoded.left) {
            throw new TypeError(decoded.left.message);
        }
        const message = decoded.right!;
        const envelope = readRtcTopologyWorkEnvelope(message, AppOutboxType.RTC_TOPOLOGY_RECOMPUTE);
        const work = envelope.data;
        if (work.kind !== 'group-revision' || !work[COALESCED_APP_OUTBOX_WORK_FIELD]) {
            throw new TypeError('Coalesced group-revision predecessor lacks group-revision metadata');
        }
        const messageIdentity = {
            senderId: message.id.senderId,
            tsEpochMs: message.id.ts,
            expiresAtEpochMs: message.constraints?.expiresAtMs ?? NEVER_EXPIRE_TS.epochMilliseconds
        };
        const data = { ...work, [COALESCED_APP_OUTBOX_WORK_FIELD]: work[COALESCED_APP_OUTBOX_WORK_FIELD] };
        return { kind: 'current', entry, work: { envelope: { ...envelope, data }, messageIdentity } };
    }
    catch (cause) {
        throw new TypeError(
            'Coalesced group-revision predecessor is not coalesced topology work: ' + entry.key.resourceId,
            { cause }
        );
    }
}

/** The stored row's current coalesced work, or null when it is unsupported or corrupt. */
export function decodeCurrentCoalescedGroupRevisionWork(
    entry: ResourceEntry
): PreviousCoalescedGroupRevisionWork | null {
    try {
        const predecessor = decodeCoalescedGroupRevisionPredecessor(entry);
        return predecessor.kind === 'current' ? predecessor.work : null;
    }
    catch {
        return null;
    }
}

/**
 * The overlay a stored row replans when it is group-revision work that carries no current coalesced timing: a
 * per-command row (an explicit reconfigure or a topology-config receipt) decodes through the work codec, and a coalesced
 * row in an unsupported envelope version yields its overlay from its coalescing envelope. Any other row, RTT-refresh
 * work included, is null.
 */
export function decodeGroupRevisionWorkOverlayId(entry: ResourceEntry): string | null {
    try {
        const decoded = decodeRtcTopologyWorkEntry(entry);
        if (decoded.right !== undefined) {
            const work = readRtcTopologyWorkEnvelope(decoded.right, AppOutboxType.RTC_TOPOLOGY_RECOMPUTE).data;
            return work.kind === 'group-revision' ? work.overlayId : null;
        }
        if (decoded.left?.code === 'unsupported') {
            const data = tryReadCoalescedAppOutboxWorkEnvelope<RtcTopologyGroupRevisionWork>(entry)?.data;
            return data?.kind === 'group-revision' && typeof data.overlayId === 'string' ? data.overlayId : null;
        }
        return null;
    }
    catch {
        return null;
    }
}

function decodeUnsupportedCoalescedGeneration(entry: ResourceEntry): number {
    const generation = tryReadCoalescedAppOutboxWorkEnvelope(entry)?.data[COALESCED_APP_OUTBOX_WORK_FIELD].generation;
    if (generation === undefined || !Number.isSafeInteger(generation) || generation < 1) {
        throw new TypeError('Unsupported coalesced group-revision predecessor has no coalescing generation');
    }
    return generation;
}
