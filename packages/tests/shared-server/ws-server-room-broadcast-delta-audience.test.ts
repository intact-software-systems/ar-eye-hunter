import { describe, expect, it, vi } from 'vitest';
import { newALBroadcastMessage, newALEventRoute } from '@shared/al-contracts/al-contract.ts';
import { AppTopics } from '@shared/api/api-config.ts';
import type { GroupStateDeltaEnvelope } from '@shared/api/group-state-delta.ts';
import { validateGroupStateDeltaEnvelope } from '@shared/api/group-state-delta.ts';
// prettier-ignore
import {
  createWsServerTargetResolver,
} from '@shared-server/rallar-system/middleware/ws-server-target-resolver.ts';
import {
  createDeltaEnvelopeFixture,
  createDeltaEnvelopeFixtureGroupSnapshot,
  createDeltaEnvelopeFixtureWebSocketServer,
  DELTA_ENVELOPE_FIXTURE_GROUP_REF,
  DELTA_ENVELOPE_FIXTURE_NOW,
  readFixtureConnectionIds,
} from './group-state-delta-envelope-fixtures.ts';

const ALICE = { principalId: 'alice', sessionId: 'alice-session', role: 'owner' } as const;
const JOINING = { principalId: 'joining', sessionId: 'joining-session', role: 'member' } as const;

// The room-scope outbox dispatch path is the one production uses for group
// state sync rows. A delta-envelope row carries its own immutable audience, so
// it must reach the session whose change produced it even though no
// process-local snapshot names that session yet.
describe('room-scope broadcast delivery of group-state delta envelopes', () => {
  it('delivers to the persisted audience without consulting a group snapshot', () => {
    const server = createDeltaEnvelopeFixtureWebSocketServer([
      'alice-session',
      'joining-session',
      'stranger-session',
    ]);
    const findGroupSnapshotByRef = vi.fn(() => createDeltaEnvelopeFixtureGroupSnapshot([ALICE]));
    const resolver = createWsServerTargetResolver(server, {
      findGroupSnapshotByRef,
      now: () => DELTA_ENVELOPE_FIXTURE_NOW,
    });
    const envelope = createDeltaEnvelopeFixture({
      audienceSessionIds: ['alice-session', 'joining-session'],
      members: [ALICE, JOINING],
    });
    expect(() => validateGroupStateDeltaEnvelope(envelope)).not.toThrow();

    const recipients = resolver.resolveBroadcastRecipients?.(
      'room',
      toRoomEnvelopeMessage(envelope),
    );

    expect(readFixtureConnectionIds(recipients)).toEqual(['alice-session', 'joining-session']);
    expect(findGroupSnapshotByRef).not.toHaveBeenCalled();
  });

  it('reaches a joining session that a stale cached snapshot does not know yet', () => {
    const server = createDeltaEnvelopeFixtureWebSocketServer(['alice-session', 'joining-session']);
    // The cached snapshot predates the mutation, exactly as it does on a server
    // that has not observed the commit for this change.
    const resolver = createWsServerTargetResolver(server, {
      findGroupSnapshotByRef: () => createDeltaEnvelopeFixtureGroupSnapshot([ALICE]),
      now: () => DELTA_ENVELOPE_FIXTURE_NOW,
    });

    const recipients = resolver.resolveBroadcastRecipients?.(
      'room',
      toRoomEnvelopeMessage(
        createDeltaEnvelopeFixture({
          audienceSessionIds: ['alice-session', 'joining-session'],
          members: [ALICE, JOINING],
        }),
      ),
    );

    expect(readFixtureConnectionIds(recipients)).toContain('joining-session');
  });

  it('intersects the persisted audience with locally open connections only', () => {
    const server = createDeltaEnvelopeFixtureWebSocketServer(['alice-session']);
    const resolver = createWsServerTargetResolver(server, {
      findGroupSnapshotByRef: () => createDeltaEnvelopeFixtureGroupSnapshot([ALICE, JOINING]),
      now: () => DELTA_ENVELOPE_FIXTURE_NOW,
    });

    const recipients = resolver.resolveBroadcastRecipients?.(
      'room',
      toRoomEnvelopeMessage(
        createDeltaEnvelopeFixture({
          audienceSessionIds: ['alice-session', 'remote-session'],
          members: [ALICE, JOINING],
        }),
      ),
    );

    expect(readFixtureConnectionIds(recipients)).toEqual(['alice-session']);
  });

  it('keeps resolving snapshot rows from their own payload', () => {
    const server = createDeltaEnvelopeFixtureWebSocketServer(['alice-session', 'joining-session']);
    const resolver = createWsServerTargetResolver(server, {
      findGroupSnapshotByRef: () => createDeltaEnvelopeFixtureGroupSnapshot([ALICE]),
      now: () => DELTA_ENVELOPE_FIXTURE_NOW,
    });

    const recipients = resolver.resolveBroadcastRecipients?.(
      'room',
      newALBroadcastMessage(
        'rallar-server',
        newALEventRoute(
          AppTopics.groupStateSnapshot,
          DELTA_ENVELOPE_FIXTURE_GROUP_REF.groupId,
          'snapshot-1',
        ),
        'room',
        AppTopics.groupStateSnapshot,
        createDeltaEnvelopeFixtureGroupSnapshot([ALICE, JOINING]),
        { groupRef: DELTA_ENVELOPE_FIXTURE_GROUP_REF },
      ),
    );

    expect(readFixtureConnectionIds(recipients)).toEqual(['alice-session', 'joining-session']);
  });

  it('ignores a persisted audience carried for a different group', () => {
    const server = createDeltaEnvelopeFixtureWebSocketServer(['alice-session', 'foreign-session']);
    const resolver = createWsServerTargetResolver(server, {
      findGroupSnapshotByRef: () => createDeltaEnvelopeFixtureGroupSnapshot([ALICE]),
      now: () => DELTA_ENVELOPE_FIXTURE_NOW,
    });
    const foreignEnvelope = createDeltaEnvelopeFixture({
      audienceSessionIds: ['foreign-session'],
      members: [ALICE],
      groupId: 'other-room',
    });

    const recipients = resolver.resolveBroadcastRecipients?.(
      'room',
      newALBroadcastMessage(
        'rallar-server',
        newALEventRoute(
          AppTopics.groupStateEvent,
          DELTA_ENVELOPE_FIXTURE_GROUP_REF.groupId,
          'event-foreign',
        ),
        'room',
        AppTopics.groupStateEvent,
        foreignEnvelope,
        { groupRef: DELTA_ENVELOPE_FIXTURE_GROUP_REF },
      ),
    );

    expect(readFixtureConnectionIds(recipients)).toEqual(['alice-session']);
  });
});

function toRoomEnvelopeMessage(envelope: GroupStateDeltaEnvelope) {
  return newALBroadcastMessage(
    'rallar-server',
    newALEventRoute(
      AppTopics.groupStateEvent,
      DELTA_ENVELOPE_FIXTURE_GROUP_REF.groupId,
      envelope.event.eventId,
    ),
    'room',
    AppTopics.groupStateEvent,
    envelope,
    { groupRef: DELTA_ENVELOPE_FIXTURE_GROUP_REF },
  );
}
