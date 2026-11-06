import { decodeArenaTournamentSnapshot, type ArenaTournamentSnapshot } from '@ar-eye-hunter/arena-tournament-snapshot.ts';
import { decodeArenaTournamentFrame, decodeArenaTournamentFrameHeader, encodeArenaTournamentFrame } from '@ar-eye-hunter/arena-tournament-stream.ts';
import { AR_EYE_TOURNAMENT_RULES_ID, createTournamentArena } from '@ar-eye-hunter/tournament-arena.ts';
import { toBase64Url } from '@shared/encoding/base64url.ts';
import { describe, expect, it } from 'vitest';

const roomRef = { applicationId: 'ar-eye-hunter', workspaceId: 'default', groupId: 'semi-1' };
const snapshot: ArenaTournamentSnapshot = {
    binding: {
        tournamentRef: { applicationId: roomRef.applicationId, workspaceId: roomRef.workspaceId, tournamentId: 'cup' },
        roomRef,
        slot: 'semifinal-1',
        attemptId: 'attempt',
        gameId: 'semi-1',
        rulesId: AR_EYE_TOURNAMENT_RULES_ID,
        principalIds: ['alice', 'bob']
    },
    status: 'playing',
    observedAtEpochMs: 2000,
    attemptRevision: 31,
    state: createTournamentArena({
        gameId: 'semi-1',
        principalIds: ['alice', 'bob'],
        seed: 7,
        startedAtEpochMs: 1000,
        durationMs: 60000
    })
};

describe('native tournament frame', () => {
    it('losslessly restores a native checkpoint and its committed attempt revision', async () => {
        const encoded = await encodeArenaTournamentFrame(snapshot);
        expect(encoded.data.length).toBeLessThan(JSON.stringify(snapshot).length);
        expect(await decodeArenaTournamentFrame(encoded)).toEqual(snapshot);
    });

    it('checks the readable pre-decompression stamp against the exact recovered game value', async () => {
        const frame = await encodeArenaTournamentFrame(snapshot);
        expect(decodeArenaTournamentFrameHeader(frame)).toMatchObject({ attemptId: snapshot.binding.attemptId, attemptRevision: 31 });
        await expect(decodeArenaTournamentFrame({ ...frame, attemptRevision: 32 })).rejects.toThrow();
        await expect(decodeArenaTournamentFrame({ ...frame, attemptId: 'another-attempt' })).rejects.toThrow();
        expect(() => decodeArenaTournamentFrameHeader({ ...frame, attemptId: 'a'.repeat(256) })).toThrow();
        expect(() => decodeArenaTournamentFrameHeader({ ...frame, data: 'a'.repeat(65536) })).toThrow(/message byte limit/);
    });

    it('requires the monotonic commit stamp for scheduled and active snapshots', () => {
        const { attemptRevision: _revision, ...missing } = snapshot;
        for (const state of [null, snapshot.state]) {
            expect(() => decodeArenaTournamentSnapshot({ ...missing, state })).toThrow();
            expect(() => decodeArenaTournamentSnapshot({ ...snapshot, attemptRevision: -1, state })).toThrow();
        }
    });

    it('rejects truncation, extra fields, noncanonical data, size overflow and expansion past the declared size', async () => {
        const encoded = await encodeArenaTournamentFrame(snapshot);
        for (
            const invalid of [
                { ...encoded, extra: true },
                { ...encoded, data: encoded.data + '=' },
                { ...encoded, data: encoded.data.slice(0, -10) },
                { ...encoded, uncompressedBytes: 65537 },
                { ...encoded, data: 'A'.repeat(100000) },
                { ...encoded, uncompressedBytes: encoded.uncompressedBytes - 1 }
            ]
        ) {
            await expect(decodeArenaTournamentFrame(invalid)).rejects.toThrow();
        }
        const zipped = await new Response(new Blob([new Uint8Array(1_048_576)]).stream().pipeThrough(new CompressionStream('gzip'))).arrayBuffer();
        await expect(decodeArenaTournamentFrame({ ...encoded, data: toBase64Url(new Uint8Array(zipped)), uncompressedBytes: 65536 })).rejects.toThrow();
    });
});
