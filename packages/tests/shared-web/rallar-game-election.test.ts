import { describe, expect, it } from 'vitest';
import {
    electRallarGameHost,
    RALLAR_GAME_MISSING_CAPABILITY_SCORE,
    scoreRallarGameHostCapability,
} from '@shared-web/game/mod.ts';

describe('Rallar Game host election', () => {
    it('scores stronger fresh host capability above weaker capability', () => {
        expect(
            scoreRallarGameHostCapability({
                peerId: 'fast',
                reportedAtEpochMs: 1_000,
                fps: 120,
                rttMs: 20,
                hardwareConcurrency: 12,
                deviceMemoryGb: 16,
            }),
        ).toBeGreaterThan(
            scoreRallarGameHostCapability({
                peerId: 'slow',
                reportedAtEpochMs: 1_000,
                fps: 20,
                rttMs: 350,
                hardwareConcurrency: 2,
                deviceMemoryGb: 2,
                isMobile: true,
            }),
        );
    });

    it('elects host and backup deterministically with stable tie-breaks', () => {
        const result = electRallarGameHost({
            peerIds: ['peer-c', 'peer-a', 'peer-b'],
            nowEpochMs: 2_000,
            capabilities: [
                { peerId: 'peer-b', reportedAtEpochMs: 1_900, scoreBias: 10 },
                { peerId: 'peer-a', reportedAtEpochMs: 1_900, scoreBias: 10 },
                { peerId: 'peer-c', reportedAtEpochMs: 1_900, scoreBias: 1 },
            ],
            scoreHost: (capability) => capability.scoreBias ?? 0,
        });

        expect(result.host?.peerId).toBe('peer-a');
        expect(result.backup?.peerId).toBe('peer-b');
        expect(result.candidates.map((candidate) => candidate.peerId)).toEqual([
            'peer-a',
            'peer-b',
            'peer-c',
        ]);
    });

    it('sorts missing capability below fresh capability', () => {
        const result = electRallarGameHost({
            peerIds: ['peer-a', 'peer-b'],
            nowEpochMs: 2_000,
            capabilities: [
                { peerId: 'peer-b', reportedAtEpochMs: 1_900, scoreBias: 0 },
            ],
            scoreHost: () => 0,
        });

        expect(result.host?.peerId).toBe('peer-b');
        expect(result.backup?.peerId).toBe('peer-a');
        expect(result.backup?.score).toBe(RALLAR_GAME_MISSING_CAPABILITY_SCORE);
        expect(result.backup?.reason).toBe('missing-capability');
    });

    it('ignores stale capability after the TTL', () => {
        const result = electRallarGameHost({
            peerIds: ['peer-a', 'peer-b'],
            nowEpochMs: 20_000,
            capabilityTtlMs: 5_000,
            capabilities: [
                { peerId: 'peer-a', reportedAtEpochMs: 1_000, scoreBias: 10_000 },
                { peerId: 'peer-b', reportedAtEpochMs: 19_000, scoreBias: 1 },
            ],
            scoreHost: (capability) => capability.scoreBias ?? 0,
        });

        expect(result.host?.peerId).toBe('peer-b');
        expect(result.backup?.peerId).toBe('peer-a');
        expect(result.backup?.reason).toBe('stale-capability');
        expect(result.backup?.score).toBe(RALLAR_GAME_MISSING_CAPABILITY_SCORE);
    });

    it('excludes peers that explicitly cannot host', () => {
        const result = electRallarGameHost({
            peerIds: ['peer-a', 'peer-b'],
            nowEpochMs: 2_000,
            capabilities: [
                {
                    peerId: 'peer-a',
                    reportedAtEpochMs: 1_900,
                    canHost: false,
                    scoreBias: 100_000,
                },
                { peerId: 'peer-b', reportedAtEpochMs: 1_900, scoreBias: 1 },
            ],
            scoreHost: (capability) => capability.scoreBias ?? 0,
        });

        expect(result.host?.peerId).toBe('peer-b');
        expect(result.candidates.find((candidate) => candidate.peerId === 'peer-a'))
            .toMatchObject({
                eligible: false,
                reason: 'cannot-host',
            });
    });
});
