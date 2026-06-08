import { describe, expect, it } from 'vitest';
import type { AuthSession } from 'api/api-config.ts';
import {
    createRelicGame,
    RELIC_PROTOCOL_VERSION,
    toPublicRelicSnapshot,
} from '@ar-eye-hunter/relic-hunters/mod.ts';
import {
    createRelicAuthorityPresence,
    RELIC_AUTHORITY_REF,
    shouldAcceptRelicAuthoritySnapshotRepair,
    toRelicAuthoritySnapshotEvent,
} from '../src/game/rallar-game-authority-adapter.ts';
import type { RallarGameAuthorityEnvelope } from '@ar-eye-hunter/shared/rallar-game/mod.ts';

describe('Relic Rallar Game Authority adapter', () => {
    it('maps browser presence without exposing gameplay authority', () => {
        expect(createRelicAuthorityPresence(session(), 'room-1', 1_700_000_000_000))
            .toEqual({
                protocolVersion: RELIC_PROTOCOL_VERSION,
                sessionId: 'alice-session',
                username: 'Alice',
                roomId: 'room-1',
                sentAtEpochMs: 1_700_000_000_000,
            });
    });

    it('wraps snapshots as regular relic server events', () => {
        const snapshot = toPublicRelicSnapshot(
            createRelicGame('game-1', 'room-1', 1_700_000_000_000),
        );

        expect(toRelicAuthoritySnapshotEvent(snapshot)).toEqual({
            protocolVersion: RELIC_PROTOCOL_VERSION,
            gameId: 'game-1',
            snapshot,
        });
    });

    it('accepts peer repair only for the configured server authority and room', () => {
        const snapshot = toPublicRelicSnapshot(
            createRelicGame('game-1', 'room-1', 1_700_000_000_000),
        );
        const envelope: RallarGameAuthorityEnvelope<typeof snapshot> = {
            protocol: 'relic-hunters.authority.v1',
            kind: 'snapshot',
            roomId: 'room-1',
            senderId: 'peer-b',
            seq: 1,
            sentAtEpochMs: 1_700_000_000_500,
            authority: RELIC_AUTHORITY_REF,
            payload: snapshot,
        };

        expect(shouldAcceptRelicAuthoritySnapshotRepair(envelope, 'room-1'))
            .toBe(true);
        expect(shouldAcceptRelicAuthoritySnapshotRepair(envelope, 'room-2'))
            .toBe(false);
        expect(shouldAcceptRelicAuthoritySnapshotRepair({
            ...envelope,
            authority: { ...RELIC_AUTHORITY_REF, id: 'other-server' },
        }, 'room-1')).toBe(false);
    });
});

function session(): AuthSession {
    return {
        clientId: 'client-1',
        accessToken: 'token-1',
        username: 'Alice',
        sessionId: 'alice-session',
        expiresAtEpochMs: 1_700_000_060_000,
    };
}
