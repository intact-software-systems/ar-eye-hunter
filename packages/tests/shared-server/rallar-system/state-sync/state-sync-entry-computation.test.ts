import { describe, expect, it } from 'vitest';

import {
    computeClientStateSyncEntries,
    computeGroupStateSyncEntries
} from '@shared-server/rallar-system/state-sync/state-sync-entry-computation.ts';
import { decodePersistedALMessage } from '@shared/al-contracts/al-message-persistence-validation.ts';

import {
    createClientEventStateSync,
    createGroupDeltaStateSync,
    createGroupSnapshotStateSync
} from './create-state-sync-effect-fixture.ts';

const SENDER_PEER_ID = 'ws-service-peer';
const FACTS = { nowMs: 1_000, traceId: 'trace-state-sync-entry-computation' };

describe('state-sync entry receipts', () => {
    it('asks the receivers of a group delta to acknowledge it, under the request trace and the sending peer', () => {
        const messages = computeGroupStateSyncEntries(createGroupDeltaStateSync(FACTS), SENDER_PEER_ID)
            .map((entry) => decodePersistedALMessage(entry.resource));

        expect(messages.map((message) => message.delivery)).toEqual([
            { ownership: 'shared', reliability: 'at-least-once', ack: 'receiver' }
        ]);
        expect(messages.map((message) => [message.id.senderId, message.id.traceId])).toEqual([
            [SENDER_PEER_ID, FACTS.traceId]
        ]);
    });

    it('keeps every group snapshot page unreceipted', () => {
        const entries = computeGroupStateSyncEntries(createGroupSnapshotStateSync(FACTS), SENDER_PEER_ID);

        expect(entries.map((entry) => decodePersistedALMessage(entry.resource).delivery?.ack)).toEqual(['none']);
    });

    it('keeps a client-state event unreceipted, since a principal audience names no room to confirm against', () => {
        const entries = computeClientStateSyncEntries(createClientEventStateSync(FACTS), SENDER_PEER_ID);

        expect(entries.map((entry) => entry.message.delivery?.ack)).toEqual(['none']);
    });
});
