import {
    createRallarGameAuthorityEnvelope,
    createRallarGameAuthoritySequenceTracker,
    deriveRallarGameAuthorityDiagnostics,
    isRallarGameAuthorityEnvelope,
    resolveRallarGameAuthorityTypeIds,
    type RallarGameAuthorityClientStatus,
    type RallarGameAuthorityEnvelope,
    type RallarGameAuthorityRef
} from '@shared/rallar-game/mod.ts';
import { describe, expect, it } from 'vitest';

const authority: RallarGameAuthorityRef = {
    kind: 'server',
    id: 'server-1',
    epoch: 3
};

describe('Rallar Game Authority shared contracts', () => {
    it('resolves default authority type IDs from topicId', () => {
        expect(resolveRallarGameAuthorityTypeIds('cash.match')).toEqual({
            command: 'cash.match.command.v1',
            commandResult: 'cash.match.command-result.v1',
            event: 'cash.match.event.v1',
            snapshot: 'cash.match.snapshot.v1',
            syncRequest: 'cash.match.sync-request.v1',
            presence: 'cash.match.presence.v1'
        });

        expect(
            resolveRallarGameAuthorityTypeIds('cash.match', {
                snapshot: 'custom.snapshot.v2'
            }).snapshot
        ).toBe('custom.snapshot.v2');
    });

    it('creates and identifies protocol-scoped authority envelopes', () => {
        const envelope = createEnvelope('command', 'peer-a', { action: 'move' }, 7);

        expect(envelope).toEqual({
            protocol: 'test.authority.v1',
            kind: 'command',
            roomId: 'room-1',
            senderId: 'peer-a',
            seq: 7,
            sentAtEpochMs: 1_007,
            authority,
            payload: { action: 'move' }
        });
        expect(isRallarGameAuthorityEnvelope(envelope, 'test.authority.v1')).toBe(
            true
        );
        expect(isRallarGameAuthorityEnvelope(envelope, 'other.v1')).toBe(false);
    });

    it('rejects invalid authority envelope shapes', () => {
        expect(
            isRallarGameAuthorityEnvelope(
                {
                    protocol: 'test.authority.v1',
                    kind: 'command',
                    roomId: 'room-1',
                    senderId: 'peer-a',
                    seq: -1,
                    sentAtEpochMs: 1_000,
                    authority,
                    payload: {}
                },
                'test.authority.v1'
            )
        ).toBe(false);
        expect(
            isRallarGameAuthorityEnvelope(
                {
                    protocol: 'test.authority.v1',
                    kind: 'unknown',
                    roomId: 'room-1',
                    senderId: 'peer-a',
                    seq: 1,
                    sentAtEpochMs: 1_000,
                    authority,
                    payload: {}
                },
                'test.authority.v1'
            )
        ).toBe(false);
        expect(
            isRallarGameAuthorityEnvelope(
                {
                    protocol: 'test.authority.v1',
                    kind: 'command',
                    roomId: 'room-1',
                    senderId: 'peer-a',
                    seq: 1,
                    sentAtEpochMs: 1_000,
                    authority: { kind: 'server', id: 'server-1', epoch: -1 },
                    payload: {}
                },
                'test.authority.v1'
            )
        ).toBe(false);
    });

    it('guards protocol, room, sender, kind, authority, and sequence', () => {
        const tracker = createRallarGameAuthoritySequenceTracker();
        const envelope = createEnvelope('snapshot', 'server-1', { tick: 1 }, 10);

        expect(
            tracker.accept(envelope, {
                protocol: 'wrong',
                roomId: 'room-1',
                senderId: 'server-1',
                authorityKind: 'server',
                authorityId: 'server-1',
                minAuthorityEpoch: 3,
                kinds: ['snapshot']
            })
        ).toMatchObject({ accepted: false, reason: 'wrong-protocol' });

        expect(
            tracker.accept(envelope, {
                protocol: 'test.authority.v1',
                roomId: 'room-2',
                senderId: 'server-1',
                authorityKind: 'server',
                authorityId: 'server-1',
                minAuthorityEpoch: 3,
                kinds: ['snapshot']
            })
        ).toMatchObject({ accepted: false, reason: 'wrong-room' });

        expect(
            tracker.accept(envelope, {
                protocol: 'test.authority.v1',
                roomId: 'room-1',
                senderId: 'peer-a',
                authorityKind: 'server',
                authorityId: 'server-1',
                minAuthorityEpoch: 3,
                kinds: ['snapshot']
            })
        ).toMatchObject({ accepted: false, reason: 'wrong-sender' });

        expect(
            tracker.accept(envelope, {
                protocol: 'test.authority.v1',
                roomId: 'room-1',
                senderId: 'server-1',
                authorityKind: 'browser-director',
                authorityId: 'server-1',
                minAuthorityEpoch: 3,
                kinds: ['snapshot']
            })
        ).toMatchObject({ accepted: false, reason: 'wrong-authority-kind' });

        expect(
            tracker.accept(envelope, {
                protocol: 'test.authority.v1',
                roomId: 'room-1',
                senderId: 'server-1',
                authorityKind: 'server',
                authorityId: 'server-2',
                minAuthorityEpoch: 3,
                kinds: ['snapshot']
            })
        ).toMatchObject({ accepted: false, reason: 'wrong-authority-id' });

        expect(
            tracker.accept(envelope, {
                protocol: 'test.authority.v1',
                roomId: 'room-1',
                senderId: 'server-1',
                authorityKind: 'server',
                authorityId: 'server-1',
                minAuthorityEpoch: 4,
                kinds: ['snapshot']
            })
        ).toMatchObject({ accepted: false, reason: 'stale-authority-epoch' });

        expect(
            tracker.accept(envelope, {
                protocol: 'test.authority.v1',
                roomId: 'room-1',
                senderId: 'server-1',
                authorityKind: 'server',
                authorityId: 'server-1',
                minAuthorityEpoch: 3,
                kinds: ['event']
            })
        ).toMatchObject({ accepted: false, reason: 'wrong-kind' });

        expect(
            tracker.accept(envelope, {
                protocol: 'test.authority.v1',
                roomId: 'room-1',
                senderId: 'server-1',
                authorityKind: 'server',
                authorityId: 'server-1',
                minAuthorityEpoch: 3,
                kinds: ['snapshot']
            })
        ).toMatchObject({ accepted: true });
        expect(
            tracker.accept(envelope, {
                protocol: 'test.authority.v1',
                roomId: 'room-1',
                senderId: 'server-1',
                authorityKind: 'server',
                authorityId: 'server-1',
                minAuthorityEpoch: 3,
                kinds: ['snapshot']
            })
        ).toMatchObject({ accepted: false, reason: 'duplicate-sequence' });
        expect(
            tracker.accept({ ...envelope, seq: 9 }, {
                protocol: 'test.authority.v1',
                roomId: 'room-1',
                senderId: 'server-1',
                authorityKind: 'server',
                authorityId: 'server-1',
                minAuthorityEpoch: 3,
                kinds: ['snapshot']
            })
        ).toMatchObject({ accepted: false, reason: 'stale-sequence' });
    });

    it('tracks sequences independently by room, sender, kind, and authority epoch', () => {
        const tracker = createRallarGameAuthoritySequenceTracker();

        expect(tracker.accept(createEnvelope('event', 'server-1', {}, 10)))
            .toMatchObject({ accepted: true });
        expect(
            tracker.accept({
                ...createEnvelope('event', 'server-1', {}, 1),
                authority: { ...authority, epoch: 4 }
            })
        ).toMatchObject({ accepted: true });
        expect(tracker.accept(createEnvelope('snapshot', 'server-1', {}, 1)))
            .toMatchObject({ accepted: true });
        expect(tracker.accept(createEnvelope('event', 'server-2', {}, 1)))
            .toMatchObject({ accepted: true });
        expect(
            tracker.accept({ ...createEnvelope('event', 'server-1', {}, 1), roomId: 'room-2' })
        ).toMatchObject({ accepted: true });
    });

    it('reports missing room/session, stale authority, pending commands, and peer assist state', () => {
        const diagnostics = deriveRallarGameAuthorityDiagnostics({
            nowEpochMs: 10_000,
            status: createStatus({
                roomId: undefined,
                localPeerId: undefined,
                authorityTtlMs: 1_000,
                lastAuthoritySeenAtEpochMs: 8_000,
                pendingCommandCount: 2,
                peerAssist: {
                    enabled: true,
                    snapshotRepairEnabled: true,
                    readyPeerIds: []
                }
            })
        });

        expect(diagnostics.issues).toEqual([
            'no-local-peer',
            'no-room',
            'peer-assist-not-ready',
            'pending-commands',
            'stale-authority'
        ]);
        expect(diagnostics.pendingCommandCount).toBe(2);
        expect(diagnostics.peerAssist.snapshotRepairEnabled).toBe(true);
    });
});

function createEnvelope<T>(
    kind: RallarGameAuthorityEnvelope<T>['kind'],
    senderId: string,
    payload: T,
    seq: number
): RallarGameAuthorityEnvelope<T> {
    return createRallarGameAuthorityEnvelope({
        protocol: 'test.authority.v1',
        kind,
        roomId: 'room-1',
        senderId,
        seq,
        sentAtEpochMs: 1_000 + seq,
        authority,
        payload
    });
}

function createStatus(
    overrides: Partial<RallarGameAuthorityClientStatus>
): RallarGameAuthorityClientStatus {
    return {
        phase: 'ready',
        protocol: 'test.authority.v1',
        topicId: 'game.authority',
        roomId: 'room-1',
        localPeerId: 'peer-a',
        authority,
        started: true,
        stopped: false,
        pendingCommandCount: 0,
        peerAssist: {
            enabled: false,
            snapshotRepairEnabled: false,
            readyPeerIds: []
        },
        updatedAtEpochMs: 10_000,
        ...overrides
    };
}
