import { RallarTournament } from '@shared-web/browser/tournaments/rallar-tournament.ts';
import type { TournamentSnapshot } from '@shared/api/tournaments/tournament-snapshot.ts';
import { createDefaultTimers } from '@shared/resilience/timers.ts';
import { computeTournament, createTournament } from '@shared/tournaments/compute-tournament.ts';
import type { TournamentCommand } from '@shared/tournaments/tournament-command.ts';
import { afterEach, describe, expect, it, vi } from 'vitest';

const scope = { applicationId: 'game', workspaceId: 'default' };
const ref = { ...scope, tournamentId: 'cup' };
const session = { clientId: 'alice', username: 'alice', sessionId: 'alice-session', accessToken: 'test-only', expiresAtEpochMs: 9999999999999 };
const owners: RallarTournament[] = [];
afterEach(() => owners.splice(0).forEach((owner) => owner.stop()));

function browser() {
    let snapshot: TournamentSnapshot = { ref, principalId: 'alice', observedAtEpochMs: 1000, tournament: null };
    const api = {
        read: vi.fn<RallarTournament.Api['read']>(async () => snapshot),
        change: vi.fn<RallarTournament.Api['change']>(async (input) => ({ ref, requestId: input.requestId, status: 'applied', code: null }))
    };
    const enter = vi.fn();
    const owner = new RallarTournament({
        auth: { session: () => session, onChange: () => () => {} },
        activity: { isActive: () => true, onChange: () => () => {} },
        timers: createDefaultTimers(),
        createId: () => crypto.randomUUID(),
        api,
        entry: { enter }
    }, { scope, tournamentId: 'cup', refreshIntervalMs: 10000 });
    owners.push(owner);
    return {
        owner,
        api,
        enter,
        snapshot(next: TournamentSnapshot) {
            snapshot = next;
        }
    };
}

describe('Tournament browser ownership', () => {
    it('rejects responses belonging to another tournament or account', async () => {
        const test = browser();
        test.snapshot({ ref: { ...ref, tournamentId: 'other' }, principalId: 'alice', observedAtEpochMs: 1000, tournament: null });
        await test.owner.start();
        expect(test.owner.getState().view).toBeNull();
        expect(test.owner.getState().error).toContain('another account or tournament');
        test.snapshot({ ref, principalId: 'bob', observedAtEpochMs: 1000, tournament: null });
        await test.owner.refresh();
        expect(test.owner.getState().view).toBeNull();
    });
    it('retries an ambiguous command with its exact original identity and intent', async () => {
        const test = browser();
        await test.owner.start();
        test.api.change.mockRejectedValueOnce(new Error('Response lost'));
        await test.owner.act({ type: 'create', title: 'Friday cup' });
        const first = test.api.change.mock.calls[0][0];
        await test.owner.act({ type: 'cancel' });
        expect(test.api.change).toHaveBeenCalledTimes(1);
        await test.owner.retry();
        expect(test.api.change.mock.calls[1][0]).toMatchObject({ ref, requestId: first.requestId, request: first.request });
        expect(test.owner.getState().retryPending).toBe(false);
    });
    it('enters only a freshly verified playing match with the authenticated participation role', async () => {
        const test = browser();
        let tournament = createTournament({
            ref,
            title: 'Cup',
            organizerPrincipalId: 'alice',
            rulesId: 'native-v1',
            createdAtEpochMs: 1,
            noShowGraceMs: 600000
        });
        const apply = (command: TournamentCommand, actorPrincipalId = 'alice') => {
            tournament = computeTournament({ state: tournament, command, actorPrincipalId, nowEpochMs: 1000, results: [] }).state;
        };
        for (const actor of ['alice', 'bob', 'carol', 'dave']) {
            apply({ type: 'register' }, actor);
        }
        apply({ type: 'launch' });
        apply({ type: 'schedule', slot: 'semifinal-1', attemptId: 'attempt', roomId: 'room', gameId: 'room', scheduledAtEpochMs: 1000 });
        test.snapshot({ ref, principalId: 'alice', observedAtEpochMs: 1000, tournament });
        await test.owner.start();
        await test.owner.enter('semifinal-1');
        expect(test.enter).not.toHaveBeenCalled();
        for (const actor of ['alice', 'bob']) {
            apply({ type: 'check-in', slot: 'semifinal-1', attemptId: 'attempt' }, actor);
        }
        apply({ type: 'start', slot: 'semifinal-1', attemptId: 'attempt' });
        test.snapshot({ ref, principalId: 'alice', observedAtEpochMs: 1000, tournament });
        await test.owner.enter('semifinal-1');
        expect(test.enter).toHaveBeenCalledWith({
            intent: 'join',
            roomRef: { ...scope, groupId: 'room' },
            participation: 'player',
            joinCode: null,
            preserveCurrentMembership: true
        });
    });
});
