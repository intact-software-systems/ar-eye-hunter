import { decodePersistedALMessageRow } from '@shared/al-contracts/al-message-persistence-validation.ts';
import type { ALOutboundDequeueCoalescing } from '@shared/alm/outbound/lane/claim-al-outbound-work.ts';
import { compareGroupCausalRevision, isGroupCausalRevisionAtOrAfter } from '@shared/api/group-client-views.ts';
import type { GroupStateCausalRevision } from '@shared/api/group-types.ts';
import type { ResourceEntry } from '@shared/queuebox/ResourceEntry.ts';

import { groupStateGroupStorageKey } from '../group-state/persistence/aggregate/group-aggregate-storage-keys.ts';
import { decodeStateSyncMessage } from './state-sync-payload.ts';

interface QueuedGroupDelta {
    readonly entry: ResourceEntry;
    readonly groupKey: string;
    readonly resulting: GroupStateCausalRevision;
    readonly predecessor: GroupStateCausalRevision;
    readonly audienceSessionIds: readonly string[];
}

/**
 * Of queued WS outbox rows, oldest first, the group-state deltas that a newer delta of the same group makes
 * redundant. A browser applies a delta only onto its predecessor and re-reads the snapshot on any gap, so the
 * newest delta of a group leaves every recipient at that delta's state or later, as the whole run would have.
 * An older delta is superseded only when the newest one is at or after its resulting revision and reaches every
 * session it would have reached; every other row, of any topic, is sent as queued.
 */
export function resolveStateSyncOutboxCoalescing(entries: readonly ResourceEntry[]): ALOutboundDequeueCoalescing {
    const deltas = entries.flatMap((entry) => readQueuedGroupDelta(entry) ?? []);
    const newestByGroup = new Map<string, QueuedGroupDelta>();
    for (const delta of deltas) {
        const newest = newestByGroup.get(delta.groupKey);
        if (newest === undefined || isNewerDelta(delta, newest)) {
            newestByGroup.set(delta.groupKey, delta);
        }
    }
    const superseded = deltas.filter((delta) => isSupersededBy(delta, newestByGroup.get(delta.groupKey)!));
    const survivorKeys = new Set(superseded.map((delta) => delta.groupKey));
    return {
        superseded: superseded.map((delta) => delta.entry),
        survivors: [...survivorKeys].map((groupKey) => newestByGroup.get(groupKey)!.entry)
    };
}

/**
 * A later resulting revision wins. At an equal one the delta with the earlier predecessor wins: the first delta
 * of a coalesced summary write carries the whole write's slice and applies where its write-nothing siblings
 * would only send a browser back to the snapshot.
 */
function isNewerDelta(delta: QueuedGroupDelta, newest: QueuedGroupDelta): boolean {
    const order = compareGroupCausalRevision(delta.resulting, newest.resulting);
    return order === 'dominates' ||
        order === 'equal' && compareGroupCausalRevision(delta.predecessor, newest.predecessor) === 'dominated';
}

function isSupersededBy(delta: QueuedGroupDelta, newest: QueuedGroupDelta): boolean {
    const reached = new Set(newest.audienceSessionIds);
    return newest !== delta &&
        isGroupCausalRevisionAtOrAfter(newest.resulting, delta.resulting) &&
        delta.audienceSessionIds.every((sessionId) => reached.has(sessionId));
}

function readQueuedGroupDelta(entry: ResourceEntry): QueuedGroupDelta | undefined {
    let decoded: ReturnType<typeof decodeStateSyncMessage>;
    try {
        decoded = decodeStateSyncMessage(decodePersistedALMessageRow(entry));
    }
    catch {
        return undefined;
    }
    if (decoded.kind !== 'decoded' || decoded.payload.kind !== 'group-event') {
        return undefined;
    }
    const { envelope } = decoded.payload;
    return {
        entry,
        groupKey: groupStateGroupStorageKey(envelope.group),
        resulting: envelope.resultingCausalRevision,
        predecessor: envelope.predecessorCausalRevision,
        audienceSessionIds: envelope.audienceSessionIds
    };
}
