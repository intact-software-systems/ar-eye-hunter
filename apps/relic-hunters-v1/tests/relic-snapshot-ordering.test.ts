import { RELIC_PROTOCOL_VERSION, type RelicEvent, type RelicPublicSnapshot } from '@ar-eye-hunter/relic-hunters/mod.ts';
import { describe, expect, it } from 'vitest';
import { classifyRelicSnapshotAcceptance, shouldAcceptRelicSnapshot } from '../src/game/relic-snapshot-ordering.ts';

describe('relic snapshot ordering', () => {
    it('rejects snapshots for a different expected room', () => {
        const current = snapshot({ roomId: 'room-1' });
        const candidate = snapshot({ roomId: 'room-2' });

        expect(classifyRelicSnapshotAcceptance({
            current,
            candidate,
            expectedRoomId: 'room-1'
        })).toEqual({
            accepted: false,
            reason: 'room-mismatch'
        });
    });

    it('rejects older snapshots for the same room', () => {
        const current = snapshot({ updatedAtEpochMs: 20, round: 2 });
        const candidate = snapshot({ updatedAtEpochMs: 19, round: 3 });

        expect(classifyRelicSnapshotAcceptance({ current, candidate })).toEqual({
            accepted: false,
            reason: 'older-updated-at'
        });
    });

    it('rejects lower-round snapshots with the same update timestamp', () => {
        const current = snapshot({ updatedAtEpochMs: 20, round: 2 });
        const candidate = snapshot({ updatedAtEpochMs: 20, round: 1 });

        expect(classifyRelicSnapshotAcceptance({ current, candidate })).toEqual({
            accepted: false,
            reason: 'older-round'
        });
    });

    it('rejects same-version snapshots with less complete event or submission state', () => {
        const current = snapshot({
            updatedAtEpochMs: 20,
            round: 1,
            submittedPlayerIds: ['alice-session'],
            events: [event('event-1'), event('event-2')]
        });
        const candidate = snapshot({
            updatedAtEpochMs: 20,
            round: 1,
            submittedPlayerIds: [],
            events: [event('event-1')]
        });

        expect(classifyRelicSnapshotAcceptance({ current, candidate })).toEqual({
            accepted: false,
            reason: 'less-complete-same-version'
        });
    });

    it('accepts same-version snapshots that preserve richer state', () => {
        const current = snapshot({
            updatedAtEpochMs: 20,
            round: 1,
            submittedPlayerIds: ['alice-session'],
            events: [event('event-1')]
        });
        const candidate = snapshot({
            updatedAtEpochMs: 20,
            round: 1,
            submittedPlayerIds: ['alice-session', 'bob-session'],
            events: [event('event-1'), event('event-2')]
        });

        expect(shouldAcceptRelicSnapshot({ current, candidate })).toBe(true);
    });

    it('does not replace same-round review snapshots with older planning-phase state', () => {
        const current = snapshot({
            phase: 'review',
            updatedAtEpochMs: 20,
            round: 1,
            submittedPlayerIds: [],
            events: [event('reveal'), event('move')]
        });
        const candidate = snapshot({
            phase: 'planning',
            updatedAtEpochMs: 20,
            round: 1,
            submittedPlayerIds: ['alice-session'],
            events: [event('reveal')]
        });

        expect(classifyRelicSnapshotAcceptance({ current, candidate })).toEqual({
            accepted: false,
            reason: 'phase-regression'
        });
    });

    it('accepts snapshots for a newly selected room even if that room has an older clock', () => {
        const current = snapshot({
            roomId: 'room-1',
            gameId: 'room-1',
            updatedAtEpochMs: 20
        });
        const candidate = snapshot({
            roomId: 'room-2',
            gameId: 'room-2',
            updatedAtEpochMs: 10
        });

        expect(shouldAcceptRelicSnapshot({
            current,
            candidate,
            expectedRoomId: 'room-2'
        })).toBe(true);
    });

    it('allows explicit reset hydration to semantically regress to a fresh lobby', () => {
        const current = snapshot({
            phase: 'planning',
            updatedAtEpochMs: 20,
            round: 3,
            submittedPlayerIds: ['alice-session'],
            events: [event('event-1'), event('event-2')]
        });
        const candidate = snapshot({
            phase: 'lobby',
            updatedAtEpochMs: 20,
            round: 1,
            players: [],
            submittedPlayerIds: [],
            events: []
        });

        expect(shouldAcceptRelicSnapshot({
            current,
            candidate,
            allowSemanticRegression: true
        })).toBe(true);
    });
});

function snapshot(
    overrides: Partial<RelicPublicSnapshot> = {}
): RelicPublicSnapshot {
    return {
        protocolVersion: RELIC_PROTOCOL_VERSION,
        gameId: 'room-1',
        roomId: 'room-1',
        phase: 'planning',
        round: 1,
        maxRounds: 10,
        updatedAtEpochMs: 10,
        roundTimeLimitMs: 180_000,
        map: [],
        relics: [],
        roomInvestigations: [],
        players: [
            {
                playerId: 'alice-session',
                username: 'Alice',
                characterId: 'kael-ironstride',
                roomId: 'entrance',
                health: 3,
                escaped: false,
                defeated: false,
                score: 0,
                relicIds: []
            }
        ],
        submittedPlayerIds: [],
        events: [],
        winnerIds: [],
        ...overrides
    };
}

function event(id: string): RelicEvent {
    return {
        id,
        round: 1,
        type: 'round_started',
        message: `${id} happened.`,
        tone: 'mystery',
        createdAtEpochMs: 10
    };
}
