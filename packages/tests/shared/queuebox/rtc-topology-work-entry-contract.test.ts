import { describe, expect, it } from 'vitest';

import { computeCoalescedRtcTopologyGroupRevisionWork } from '@shared-server/rallar-system/topology/replay/work/rtc-topology-coalesced-group-revision-work.ts';
import type { ResourceEntry } from '@shared/queuebox/ResourceEntry.ts';
import {
    decodeRtcTopologyWorkEntry,
    readRtcTopologyWorkEntry
} from '@shared/queuebox/rtc-topology-work-entry-contract.ts';
import { createRtcTopologyGroupSnapshot } from '../../shared-server/rallar-system/topology/rtc-topology-test-fixtures.ts';

const REQUESTED_AT_EPOCH_MS = 1_000;

function createValidEntry(): ResourceEntry {
    return computeCoalescedRtcTopologyGroupRevisionWork({
        traceId: 'trace-rtc-topology-work-entry-contract',
        aggregateRef: { applicationId: 'app-1', workspaceId: 'workspace-1', groupId: 'room-1' },
        groupSnapshot: createRtcTopologyGroupSnapshot('room-1', ['peer-1']),
        requestedAtEpochMs: REQUESTED_AT_EPOCH_MS,
        expireAtEpochMs: REQUESTED_AT_EPOCH_MS + 3_600_000,
        timing: {
            window: { debounceMs: 0, maxWaitMs: 2_000 },
            replanNotBeforeEpochMs: null,
            expectedMembersArrived: false
        },
        senderId: 'server-1',
        origin: 'automatic',
        previousEntry: null
    }).entryWrite.entry;
}

function toEntryWithEnvelopeVersion(entry: ResourceEntry, version: number): ResourceEntry {
    const message = readRtcTopologyWorkEntry(entry);
    return { ...entry, resource: JSON.stringify({ ...message, id: { ...message.id, v: version } }) };
}

describe('decodeRtcTopologyWorkEntry', () => {
    it('answers an unsupported left for a head stamped with another envelope version', () => {
        const decoded = decodeRtcTopologyWorkEntry(toEntryWithEnvelopeVersion(createValidEntry(), 3));
        expect(decoded.left).toEqual({
            code: 'unsupported',
            message: 'AL envelope version is unsupported'
        });
    });

    it('answers the message for a current head', () => {
        const validEntry = createValidEntry();
        expect(decodeRtcTopologyWorkEntry(validEntry).right).toEqual(readRtcTopologyWorkEntry(validEntry));
    });

    it('still throws when the queue identity is not RTC topology work', () => {
        const validEntry = createValidEntry();
        expect(() => decodeRtcTopologyWorkEntry({ ...validEntry, key: { ...validEntry.key, topicId: 'other' } }))
            .toThrow(/queue identity is invalid/);
    });
});
