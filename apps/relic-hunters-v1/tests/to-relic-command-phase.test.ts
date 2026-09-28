import { createRelicGame, toPublicRelicSnapshot } from '@ar-eye-hunter/relic-hunters/mod.ts';
import { describe, expect, it } from 'vitest';
import { toRelicCommandPhase } from '../src/game/to-relic-command-phase.ts';

describe('what the hunter sees after a command (D57 as applied, D72)', () => {
    it('reads an acknowledged WS command as ready; its snapshot arrives on the snapshot channel', () => {
        expect(
            toRelicCommandPhase({
                transport: 'ws',
                delivery: { state: 'acknowledged', reason: undefined }
            }, true)
        ).toEqual({
            phase: 'ready',
            patch: {
                snapshotReady: true,
                commandTransport: 'ws',
                lastCommandDelivery: 'acknowledged',
                lastError: undefined
            },
            error: undefined
        });
    });

    // A server-addressed command tracks the server as its expected peer, so the server's pre-admission refusal ends
    // that receipt row: the handle reads `failed` with the receipt-exhausted detail, never C3's `rejected` fact.
    it('reads a WS command the server did not confirm as degraded, naming its state and reason', () => {
        const phase = toRelicCommandPhase({
            transport: 'ws',
            delivery: {
                state: 'failed',
                reason: 'Hop default-qbox-server refused the message: unauthorized.'
            }
        }, true);

        expect(phase.phase).toBe('degraded');
        expect(phase.error).toBe(
            'The server did not confirm the command (failed): Hop default-qbox-server refused the message: unauthorized.'
        );
        expect(phase.patch).toMatchObject({
            commandTransport: 'ws',
            lastCommandDelivery: 'failed',
            lastError: phase.error
        });
    });

    it('keeps the REST reply\'s reading while REST is the fallback', () => {
        const snapshot = toPublicRelicSnapshot(
            createRelicGame('room-1', 'room-1', 1_700_000_000_000)
        );

        expect(toRelicCommandPhase({ transport: 'rest', snapshot }, true)).toMatchObject({
            phase: 'ready',
            patch: { commandTransport: 'rest', lastError: undefined },
            error: undefined
        });
        expect(toRelicCommandPhase({ transport: 'rest', snapshot: undefined }, false))
            .toMatchObject({
                phase: 'degraded',
                patch: { lastError: 'No relic snapshot returned for command.' }
            });
    });
});
