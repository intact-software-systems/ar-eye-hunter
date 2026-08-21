import { createRallarGameEnvelope, createRallarGameSequenceTracker, isRallarGameEnvelope } from '@shared-web/game/mod.ts';
import { describe, expect, it } from 'vitest';

describe('Rallar Game envelopes', () => {
    it('creates and identifies protocol-scoped envelopes', () => {
        const envelope = createRallarGameEnvelope({
            protocol: 'test.game.v1',
            kind: 'input',
            roomId: 'room-1',
            senderId: 'peer-1',
            seq: 7,
            directorEpoch: 3,
            sentAtEpochMs: 1_000,
            payload: { moveX: 1 }
        });

        expect(envelope).toEqual({
            protocol: 'test.game.v1',
            kind: 'input',
            roomId: 'room-1',
            senderId: 'peer-1',
            seq: 7,
            directorEpoch: 3,
            sentAtEpochMs: 1_000,
            payload: { moveX: 1 }
        });
        expect(isRallarGameEnvelope(envelope, 'test.game.v1')).toBe(true);
        expect(isRallarGameEnvelope(envelope, 'other.v1')).toBe(false);
    });

    it('retains a supplied match identity', () => {
        const envelope = createRallarGameEnvelope({
            protocol: 'test.game.v1',
            kind: 'input',
            roomId: 'room-1',
            senderId: 'peer-1',
            seq: 10,
            directorEpoch: 3,
            sentAtEpochMs: 1_000,
            matchId: 'match-a',
            payload: { moveX: 1 }
        });

        expect(envelope.matchId).toBe('match-a');
    });

    it('rejects a different configured match identity', () => {
        const tracker = createRallarGameSequenceTracker();
        const envelope = createRallarGameEnvelope({
            protocol: 'test.game.v1',
            kind: 'input',
            roomId: 'room-1',
            senderId: 'peer-1',
            seq: 10,
            directorEpoch: 3,
            sentAtEpochMs: 1_000,
            matchId: 'match-a',
            payload: { moveX: 1 }
        });

        expect(tracker.accept(envelope, { matchId: 'match-b' })).toEqual({
            accepted: false,
            reason: 'wrong-match',
            envelope
        });
    });

    it('rejects a missing match identity when one is configured', () => {
        const tracker = createRallarGameSequenceTracker();
        const envelope = createRallarGameEnvelope({
            protocol: 'test.game.v1',
            kind: 'input',
            roomId: 'room-1',
            senderId: 'peer-1',
            seq: 10,
            directorEpoch: 3,
            sentAtEpochMs: 1_000,
            payload: { moveX: 1 }
        });

        expect(tracker.accept(envelope, { matchId: 'match-b' })).toEqual({
            accepted: false,
            reason: 'wrong-match',
            envelope
        });
    });

    it('keeps sequences independent per match identity', () => {
        const tracker = createRallarGameSequenceTracker();
        const matchAEnvelope = createRallarGameEnvelope({
            protocol: 'test.game.v1',
            kind: 'input',
            roomId: 'room-1',
            senderId: 'peer-1',
            seq: 10,
            directorEpoch: 3,
            sentAtEpochMs: 1_000,
            matchId: 'match-a',
            payload: { moveX: 1 }
        });
        const matchBEnvelope = createRallarGameEnvelope({
            ...matchAEnvelope,
            seq: 1,
            matchId: 'match-b'
        });

        expect(tracker.accept(matchAEnvelope, { matchId: 'match-a' }))
            .toMatchObject({ accepted: true });
        expect(tracker.accept(matchBEnvelope, { matchId: 'match-b' }))
            .toMatchObject({ accepted: true });
    });

    it('identifies envelopes with an explicit undefined match identity', () => {
        expect(isRallarGameEnvelope({
            ...validEnvelope,
            matchId: undefined
        }, 'test.game.v1')).toBe(true);
    });

    it('rejects a null match identity', () => {
        expect(isRallarGameEnvelope({
            ...validEnvelope,
            matchId: null
        }, 'test.game.v1')).toBe(false);
    });

    it('rejects a numeric match identity', () => {
        expect(isRallarGameEnvelope({
            ...validEnvelope,
            matchId: 1
        }, 'test.game.v1')).toBe(false);
    });

    it('rejects an object match identity', () => {
        expect(isRallarGameEnvelope({
            ...validEnvelope,
            matchId: { id: 'match-a' }
        }, 'test.game.v1')).toBe(false);
    });

    it('rejects invalid envelope shapes', () => {
        expect(
            isRallarGameEnvelope(
                {
                    protocol: 'test.game.v1',
                    kind: 'input',
                    roomId: 'room-1',
                    senderId: 'peer-1',
                    seq: -1,
                    directorEpoch: 1,
                    sentAtEpochMs: 1_000,
                    payload: {}
                },
                'test.game.v1'
            )
        ).toBe(false);
        expect(
            isRallarGameEnvelope(
                {
                    protocol: 'test.game.v1',
                    kind: 'unknown',
                    roomId: 'room-1',
                    senderId: 'peer-1',
                    seq: 1,
                    directorEpoch: 1,
                    sentAtEpochMs: 1_000,
                    payload: {}
                },
                'test.game.v1'
            )
        ).toBe(false);
    });

    it('guards protocol, room, sender, epoch, kind, and sequence', () => {
        const tracker = createRallarGameSequenceTracker();
        const envelope = createRallarGameEnvelope({
            protocol: 'test.game.v1',
            kind: 'snapshot',
            roomId: 'room-1',
            senderId: 'director-1',
            seq: 10,
            directorEpoch: 4,
            sentAtEpochMs: 1_000,
            payload: { tick: 1 }
        });

        expect(
            tracker.accept(envelope, {
                protocol: 'wrong',
                roomId: 'room-1',
                senderId: 'director-1',
                minDirectorEpoch: 4,
                kinds: ['snapshot']
            })
        ).toMatchObject({ accepted: false, reason: 'wrong-protocol' });

        expect(
            tracker.accept(envelope, {
                protocol: 'test.game.v1',
                roomId: 'room-2',
                senderId: 'director-1',
                minDirectorEpoch: 4,
                kinds: ['snapshot']
            })
        ).toMatchObject({ accepted: false, reason: 'wrong-room' });

        expect(
            tracker.accept(envelope, {
                protocol: 'test.game.v1',
                roomId: 'room-1',
                senderId: 'director-2',
                minDirectorEpoch: 4,
                kinds: ['snapshot']
            })
        ).toMatchObject({ accepted: false, reason: 'wrong-sender' });

        expect(
            tracker.accept(envelope, {
                protocol: 'test.game.v1',
                roomId: 'room-1',
                senderId: 'director-1',
                minDirectorEpoch: 5,
                kinds: ['snapshot']
            })
        ).toMatchObject({ accepted: false, reason: 'stale-epoch' });

        expect(
            tracker.accept(envelope, {
                protocol: 'test.game.v1',
                roomId: 'room-1',
                senderId: 'director-1',
                minDirectorEpoch: 4,
                kinds: ['event']
            })
        ).toMatchObject({ accepted: false, reason: 'wrong-kind' });

        expect(
            tracker.accept(envelope, {
                protocol: 'test.game.v1',
                roomId: 'room-1',
                senderId: 'director-1',
                minDirectorEpoch: 4,
                kinds: ['snapshot']
            })
        ).toMatchObject({ accepted: true });
        expect(
            tracker.accept(envelope, {
                protocol: 'test.game.v1',
                roomId: 'room-1',
                senderId: 'director-1',
                minDirectorEpoch: 4,
                kinds: ['snapshot']
            })
        ).toMatchObject({ accepted: false, reason: 'duplicate-sequence' });
        expect(
            tracker.accept(
                { ...envelope, seq: 9 },
                {
                    protocol: 'test.game.v1',
                    roomId: 'room-1',
                    senderId: 'director-1',
                    minDirectorEpoch: 4,
                    kinds: ['snapshot']
                }
            )
        ).toMatchObject({ accepted: false, reason: 'stale-sequence' });
    });

    it('keeps sequences independent per director epoch', () => {
        const tracker = createRallarGameSequenceTracker();

        expect(
            tracker.accept(
                createRallarGameEnvelope({
                    protocol: 'test.game.v1',
                    kind: 'event',
                    roomId: 'room-1',
                    senderId: 'director-1',
                    seq: 10,
                    directorEpoch: 4,
                    sentAtEpochMs: 1_000,
                    payload: {}
                })
            )
        ).toMatchObject({ accepted: true });
        expect(
            tracker.accept(
                createRallarGameEnvelope({
                    protocol: 'test.game.v1',
                    kind: 'event',
                    roomId: 'room-1',
                    senderId: 'director-1',
                    seq: 1,
                    directorEpoch: 5,
                    sentAtEpochMs: 2_000,
                    payload: {}
                })
            )
        ).toMatchObject({ accepted: true });
    });
});

const validEnvelope = {
    protocol: 'test.game.v1',
    kind: 'input',
    roomId: 'room-1',
    senderId: 'peer-1',
    seq: 1,
    directorEpoch: 1,
    sentAtEpochMs: 1_000,
    payload: {}
};
