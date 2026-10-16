import { Temporal } from '@js-temporal/polyfill';
import { describe, expect, it } from 'vitest';

import { resolveStateSyncOutboxCoalescing } from '@shared-server/rallar-system/state-sync/resolve-state-sync-outbox-coalescing.ts';
import { newALBroadcastMessage, newALEventRoute } from '@shared/al-contracts/al-contract.ts';
import { AppTopics } from '@shared/api/api-config.ts';
import type { GroupStateDeltaEnvelope } from '@shared/api/group-state-delta.ts';
import type { GroupStateCausalRevision } from '@shared/api/group-types.ts';
import type { ResourceEntry } from '@shared/queuebox/ResourceEntry.ts';
import { QueueBoxUtilities } from '@shared/services/queue-box-utilities.ts';

import {
    createDeltaEnvelopeFixture,
    DELTA_ENVELOPE_FIXTURE_GROUP_REF
} from '../group-state/presence/group-state-delta-envelope-fixtures.ts';

const ALL = ['alice-session', 'bob-session'];

describe('resolveStateSyncOutboxCoalescing', () => {
    it('supersedes every older delta of one group by the newest one that reaches all of their sessions', () => {
        const older = toEntry('event-1', revision(3), revision(4), ALL);
        const middle = toEntry('event-2', revision(4), revision(5), ['alice-session']);
        const newest = toEntry('event-3', revision(5), revision(6), ALL);

        expect(resolveStateSyncOutboxCoalescing([older, middle, newest])).toEqual({
            superseded: [older, middle],
            survivors: [newest]
        });
    });

    it('keeps an older delta that reaches a session the newest one does not', () => {
        const older = toEntry('event-1', revision(3), revision(4), [...ALL, 'carol-session']);
        const newest = toEntry('event-2', revision(4), revision(5), ALL);

        expect(resolveStateSyncOutboxCoalescing([older, newest])).toEqual({ superseded: [], survivors: [] });
    });

    it('keeps the delta that carries a coalesced write\'s slice over its write-nothing siblings', () => {
        const slice = toEntry('event-1', revision(3), revision(5), ALL);
        const sibling = toEntry('event-2', revision(5), revision(5), ALL);

        expect(resolveStateSyncOutboxCoalescing([slice, sibling])).toEqual({ superseded: [sibling], survivors: [slice] });
    });

    it('never supersedes across groups, by an incomparable revision, or a row that is not a group delta', () => {
        const groupOne = toEntry('event-1', revision(3), revision(4), ALL);
        const otherGroup = toEntry('event-2', revision(4), revision(5), ALL, 'room-2');
        const incomparable = toEntry('event-3', revision(3), { groupRevision: 3, presenceRevision: 9 }, ALL);
        const malformed = { ...groupOne, resource: '{' };

        expect(resolveStateSyncOutboxCoalescing([groupOne, otherGroup, incomparable, malformed])).toEqual({
            superseded: [],
            survivors: []
        });
    });
});

function revision(groupRevision: number): GroupStateCausalRevision {
    return { groupRevision, presenceRevision: 2 };
}

function toEntry(
    eventId: string,
    predecessor: GroupStateCausalRevision,
    resulting: GroupStateCausalRevision,
    audienceSessionIds: readonly string[],
    groupId: string = DELTA_ENVELOPE_FIXTURE_GROUP_REF.groupId
): ResourceEntry {
    const fixture = createDeltaEnvelopeFixture({ audienceSessionIds, groupId });
    const envelope: GroupStateDeltaEnvelope = {
        ...fixture,
        event: { ...fixture.event, eventId, causalRevision: resulting, snapshotVersion: resulting.groupRevision },
        predecessorCausalRevision: predecessor,
        resultingCausalRevision: resulting,
        group: {
            ...fixture.group,
            snapshotVersion: resulting.groupRevision,
            presenceVersion: resulting.presenceRevision
        }
    };
    const message = newALBroadcastMessage(
        'rallar-server',
        newALEventRoute(AppTopics.groupStateEvent, groupId, eventId),
        'room',
        AppTopics.groupStateEvent,
        envelope,
        { groupRef: { ...DELTA_ENVELOPE_FIXTURE_GROUP_REF, groupId } }
    );
    return QueueBoxUtilities.toResourceEntryFromMsg(message, 'outbox', Temporal.Now.instant());
}
