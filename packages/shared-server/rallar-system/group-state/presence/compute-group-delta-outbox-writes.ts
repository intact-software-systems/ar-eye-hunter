import { decodePersistedALMessage } from '@shared/al-contracts/al-message-persistence-validation.ts';
import { EnqueuedType } from '@shared/api/api-config.ts';
import type { GroupRef } from '@shared/api/group-types.ts';
import type { ResourceEntry } from '@shared/queuebox/ResourceEntry.ts';

import {
    computeAppOutboxInsert,
    computeWsOutboxInsert,
    type AppOutboxInsert
} from '../../app-outbox/app-outbox-insert.ts';

export interface ComputeGroupDeltaOutboxWritesInput {
    readonly entries: readonly ResourceEntry[];
    readonly groupRef: GroupRef;
    readonly activeSessionIds: readonly string[];
}

/** Each delta row as it is written: a WS row with the proof of the room audience it was computed for, any other row without one. */
export function computeGroupDeltaOutboxWrites(input: ComputeGroupDeltaOutboxWritesInput): readonly AppOutboxInsert[] {
    const { entries, groupRef, activeSessionIds } = input;
    return entries.map((entry) => {
        if (entry.typeId !== EnqueuedType.WS_OUTBOX) {
            return computeAppOutboxInsert(entry);
        }
        return computeWsOutboxInsert({
            entry,
            admissionNamespace: null,
            provenance: {
                message: decodePersistedALMessage(entry.resource),
                producerKind: 'state-sync',
                target: { kind: 'scoped-room-broadcast', groupRef, admittedAudience: activeSessionIds },
                expiresAtMs: entry.audit.expiryTs.epochMilliseconds
            }
        });
    });
}
