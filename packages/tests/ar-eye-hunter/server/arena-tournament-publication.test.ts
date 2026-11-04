import type { ArenaTournamentSnapshot } from '@ar-eye-hunter/arena-tournament-snapshot.ts';
import { ArenaTournamentPublication, publishArenaTournamentSnapshot } from '@ar-eye-hunter/server/arena-tournament-publication.ts';
import { AR_EYE_TOURNAMENT_RULES_ID } from '@ar-eye-hunter/tournament-arena.ts';
import { describe, expect, it } from 'vitest';
import { createManualTimers } from '../../shared/resilience/manual-timers.ts';

const roomRef = { applicationId: 'ar-eye-hunter', workspaceId: 'default', groupId: 'semi' };
const snapshot: ArenaTournamentSnapshot = {
    binding: {
        tournamentRef: { applicationId: roomRef.applicationId, workspaceId: roomRef.workspaceId, tournamentId: 'cup' },
        slot: 'semifinal-1',
        attemptId: 'attempt',
        roomRef,
        gameId: 'game',
        rulesId: AR_EYE_TOURNAMENT_RULES_ID,
        principalIds: ['alice', 'bob']
    },
    state: null,
    status: 'scheduled',
    observedAtEpochMs: 1000,
    attemptRevision: 1
};

describe('native tournament presentation cadence', () => {
    it('coalesces four commits into one current read/encode/send, and drains a final mark at stop', async () => {
        const timers = createManualTimers(1000);
        let revision = 1;
        const sent: number[] = [];
        const owner = new ArenaTournamentPublication({
            timers,
            read: async () => ({ ...snapshot, attemptRevision: revision }),
            send: async (value) => {
                sent.push(value.attemptRevision);
            }
        });
        owner.offer(snapshot.binding);
        for (revision = 2; revision <= 4; revision++) {
            owner.offer(snapshot.binding);
        }
        expect(sent).toEqual([]);
        await timers.advanceTo(1200);
        expect(sent).toEqual([5]);
        revision = 6;
        owner.offer(snapshot.binding);
        await owner.stop();
        expect(sent).toEqual([5, 6]);
        await expect(owner.terminal(snapshot.binding, 'finished')).rejects.toThrow();
    });

    it('retries a terminal cluster receipt with a failed local socket, but accepts an empty authorized audience', async () => {
        const terminal = { ...snapshot, status: 'finished' as const };
        const timers = createManualTimers(1000);
        let localFailed = true;
        const owner = new ArenaTournamentPublication({
            timers,
            read: async () => terminal,
            send: (current) =>
                publishArenaTournamentSnapshot({
                    publish: async ({ message }) => ({
                        message,
                        entries: [],
                        fanout: 'live-only',
                        status: localFailed ? 'cluster-published' : 'no-recipients',
                        reason: localFailed ? 'socket write failed' : undefined
                    })
                }, current)
        });
        const failed = expect(owner.terminal(snapshot.binding, 'finished')).rejects.toThrow('socket write failed');
        await timers.advanceTo(1000);
        await failed;
        localFailed = false;
        const retry = owner.terminal(snapshot.binding, 'finished');
        await timers.advanceTo(1000);
        await retry;
        await owner.stop();
    });

    it('terminal reminders require the same attempt and a terminal canonical status; send failure rejects for durable retry', async () => {
        const timers = createManualTimers(1000);
        let current: ArenaTournamentSnapshot = { ...snapshot, status: 'finished' };
        let sends = 0;
        const owner = new ArenaTournamentPublication({
            timers,
            read: async () => current,
            send: async () => {
                if (++sends === 1) {
                    throw new Error('publication failed');
                }
            }
        });
        const failed = expect(owner.terminal(snapshot.binding, 'finished')).rejects.toThrow('publication failed');
        await timers.advanceTo(1000);
        await failed;
        const retried = owner.terminal(snapshot.binding, 'finished');
        await timers.advanceTo(1000);
        await retried;
        current = { ...snapshot, binding: { ...snapshot.binding, attemptId: 'replacement' } };
        const replaced = owner.terminal(snapshot.binding, 'finished');
        await timers.advanceTo(1000);
        await replaced;
        expect(sends).toBe(2);
        await owner.stop();
    });
});

it('keeps only the latest revision while a room socket write stalls across many committed ticks', async () => {
    const timers = createManualTimers(1000);
    const held = Promise.withResolvers<void>();
    const started = Promise.withResolvers<void>();
    let revision = 1;
    const sent: number[] = [];
    const owner = new ArenaTournamentPublication({
        timers,
        read: async () => ({ ...snapshot, attemptRevision: revision }),
        send: async (current) => {
            sent.push(current.attemptRevision);
            if (sent.length === 1) {
                started.resolve();
                await held.promise;
            }
        }
    });
    owner.offer(snapshot.binding);
    const first = timers.advanceTo(1200);
    await started.promise;
    for (revision = 2; revision <= 10001; revision++) {
        owner.offer(snapshot.binding);
    }
    held.resolve();
    await first;
    await timers.advanceTo(1400);
    expect(sent).toEqual([1, 10002]);
    await owner.stop();
});
