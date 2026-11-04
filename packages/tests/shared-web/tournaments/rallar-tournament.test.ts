import type { SelectedViewWatch } from '@shared-web/browser/api/selected-view-watch.ts';
import { RallarRoomEntry } from '@shared-web/browser/rooms/entry/rallar-room-entry.ts';
import type { RallarAuthState } from '@shared-web/browser/session/rallar-auth-facade.ts';
import { RallarTournament } from '@shared-web/browser/tournaments/rallar-tournament.ts';
import type { AuthSession } from '@shared/api/api-config.ts';
import type { TournamentSnapshot } from '@shared/api/tournaments/tournament-snapshot.ts';
import type { Tournament } from '@shared/api/tournaments/tournament-types.ts';
import { SynchronousNotifications } from '@shared/cache/synchronous-notifications.ts';
import { computeTournament, createTournament } from '@shared/tournaments/compute-tournament.ts';
import type { TournamentCommand } from '@shared/tournaments/tournament-command.ts';
import { afterEach, describe, expect, it, vi, type Mock, type MockInstance } from 'vitest';
import { createManualTimers, type ManualTimers } from '../../shared/resilience/manual-timers.ts';

const scope = { applicationId: 'game', workspaceId: 'default' };
const ref = { ...scope, tournamentId: 'cup' };
const session = { clientId: 'alice', username: 'alice', sessionId: 'alice-session', accessToken: 'test-only', expiresAtEpochMs: 9999999999999 };
const owners: RallarTournament[] = [];
afterEach(() => owners.splice(0).forEach((owner) => owner.stop()));

interface TournamentFixture {
    readonly owner: RallarTournament;
    readonly api: { readonly read: Mock<RallarTournament.Api['read']>; readonly change: Mock<RallarTournament.Api['change']>; };
    readonly watch: { readonly select: Mock<SelectedViewWatch['select']>; readonly release: Mock<SelectedViewWatch['release']>; };
    readonly timers: ManualTimers;
    readonly enter: MockInstance<RallarRoomEntry['enter']>;
    readonly entry: RallarRoomEntry;
    activeRegistration(): SelectedViewWatch.Selection | null;
    releasedRegistrations(): readonly SelectedViewWatch.Selection[];
    snapshot(next: TournamentSnapshot): void;
    changed(): void;
    authenticate(next: AuthSession | undefined): void;
}

function browser(): TournamentFixture {
    let currentSession: AuthSession | undefined = session;
    const authentication = new SynchronousNotifications<RallarAuthState>((error) => {
        throw error;
    });
    let snapshot: TournamentSnapshot = { ref, principalId: 'alice', observedAtEpochMs: 1000, listing: 'unlisted', tournament: null };
    const api = {
        read: vi.fn<RallarTournament.Api['read']>(async () => snapshot),
        change: vi.fn<RallarTournament.Api['change']>(async (input) => ({ ref, requestId: input.requestId, status: 'applied', code: null }))
    };
    const timers = createManualTimers(1000);
    const changes = new SynchronousNotifications<void>((error) => {
        throw error;
    });
    let activeRegistration: SelectedViewWatch.Selection | null = null;
    const releasedRegistrations: SelectedViewWatch.Selection[] = [];
    const watch = {
        select: vi.fn<SelectedViewWatch['select']>(async (selection) => {
            activeRegistration = selection;
        }),
        release: vi.fn<SelectedViewWatch['release']>(async () => {
            if (activeRegistration !== null) {
                releasedRegistrations.push(activeRegistration);
            }
            activeRegistration = null;
        })
    };
    const entry = createTournamentRoomEntry();
    const enter = vi.spyOn(entry, 'enter');
    const owner = new RallarTournament({
        auth: { session: () => currentSession, onChange: (listener) => authentication.subscribe(listener).unsubscribe },
        activity: { isActive: () => true, onChange: () => () => {} },
        timers,
        onChanged: (listener) => changes.subscribe(listener).unsubscribe,
        watch,
        readConnectionGeneration: async () => 'generation',
        createId: () => crypto.randomUUID(),
        api,
        entry
    }, { scope, tournamentId: 'cup' });
    owners.push(owner);
    return {
        owner,
        api,
        watch,
        timers,
        activeRegistration: () => activeRegistration,
        releasedRegistrations: () => releasedRegistrations,
        changed: () => changes.publishLatest(),
        authenticate(next) {
            currentSession = next;
            authentication.publishLatest({ authenticated: next !== undefined, session: next, reason: next ? 'login' : 'logout' });
        },
        enter,
        entry,
        snapshot(next: TournamentSnapshot) {
            snapshot = next;
        }
    };
}

describe('Tournament browser ownership', () => {
    it('registers a nonentrant bracket watch before reading and releases it on stop', async () => {
        const test = browser();
        const registered = Promise.withResolvers<void>();
        const started = Promise.withResolvers<void>();
        const select = test.watch.select.getMockImplementation()!;
        test.watch.select.mockImplementationOnce(async (selection) => {
            await select(selection);
            started.resolve();
            await registered.promise;
        });
        const starting = test.owner.start();
        await started.promise;
        expect(test.api.read).not.toHaveBeenCalled();
        registered.resolve();
        await starting;
        expect(test.watch.select).toHaveBeenCalledWith(
            expect.objectContaining({ resourceId: ref.tournamentId, session, connectionGenerationId: 'generation' })
        );
        expect(test.owner.getState().view).toMatchObject({ ref, principalId: 'alice' });
        expect(test.activeRegistration()).toMatchObject({ resourceId: ref.tournamentId, session });
        test.owner.stop();
        expect(test.activeRegistration()).toBeNull();
    });

    it('releases the old account watch and fences its delayed registration before canonical reads', async () => {
        const test = browser();
        const registered = Promise.withResolvers<void>();
        const started = Promise.withResolvers<void>();
        const select = test.watch.select.getMockImplementation()!;
        test.watch.select.mockImplementationOnce(async (selection) => {
            await select(selection);
            started.resolve();
            await registered.promise;
        });
        const starting = test.owner.start();
        await started.promise;
        const bob = { ...session, clientId: 'bob', sessionId: 'bob-session' };
        test.snapshot({ ref, principalId: 'bob', observedAtEpochMs: 1000, listing: 'unlisted', tournament: null });
        test.authenticate(bob);
        await vi.waitFor(() => expect(test.owner.getState().view?.principalId).toBe('bob'));
        registered.resolve();
        await starting;
        expect(test.api.read).toHaveBeenCalledTimes(1);
        expect(test.api.read).toHaveBeenCalledWith(expect.objectContaining({ session: bob }));
        expect(test.releasedRegistrations().map((selection) => selection.session.clientId)).toEqual(['alice']);
        expect(test.activeRegistration()?.session).toEqual(bob);
        test.authenticate(undefined);
        expect(test.owner.getState().view).toBeNull();
        expect(test.releasedRegistrations().map((selection) => selection.session.clientId)).toEqual(['alice', 'bob']);
        expect(test.activeRegistration()).toBeNull();
    });

    it('reads at scheduled start once and on push, without recurring bracket polling', async () => {
        const test = browser();
        const tournament = createScheduledTournament(3000);
        test.snapshot({ ref, principalId: 'alice', observedAtEpochMs: 1000, listing: 'unlisted', tournament });
        await test.owner.start();
        await test.timers.advance(1999);
        expect(test.api.read).toHaveBeenCalledTimes(1);
        test.snapshot({ ref, principalId: 'alice', observedAtEpochMs: 3000, listing: 'unlisted', tournament });
        await test.timers.advance(1);
        await vi.waitFor(() => expect(test.owner.getState().view?.observedAtEpochMs).toBe(3000));
        expect(test.api.read).toHaveBeenCalledTimes(2);
        await test.timers.advance(60000);
        expect(test.api.read).toHaveBeenCalledTimes(2);
        test.changed();
        await vi.waitFor(() => expect(test.api.read).toHaveBeenCalledTimes(3));
    });

    it('rejects responses belonging to another tournament or account', async () => {
        const test = browser();
        test.snapshot({ ref: { ...ref, tournamentId: 'other' }, principalId: 'alice', observedAtEpochMs: 1000, listing: 'unlisted', tournament: null });
        await test.owner.start();
        expect(test.owner.getState().view).toBeNull();
        expect(test.owner.getState().error).toContain('another account or tournament');
        test.snapshot({ ref, principalId: 'bob', observedAtEpochMs: 1000, listing: 'unlisted', tournament: null });
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
        let tournament = createScheduledTournament(1000);
        const apply = (command: TournamentCommand, actorPrincipalId = 'alice') => {
            tournament = computeTournament({ state: tournament, command, actorPrincipalId, nowEpochMs: 1000, results: [] }).state;
        };
        test.snapshot({ ref, principalId: 'alice', observedAtEpochMs: 1000, listing: 'unlisted', tournament });
        await test.owner.start();
        await test.owner.enter('semifinal-1');
        expect(test.enter).not.toHaveBeenCalled();
        for (const actor of ['alice', 'bob']) {
            apply({ type: 'check-in', slot: 'semifinal-1', attemptId: 'attempt' }, actor);
        }
        apply({ type: 'start', slot: 'semifinal-1', attemptId: 'attempt' });
        test.snapshot({ ref, principalId: 'alice', observedAtEpochMs: 1000, listing: 'unlisted', tournament });
        await test.owner.enter('semifinal-1');
        expect(test.enter).toHaveBeenCalledWith({
            intent: 'join',
            roomRef: { ...scope, groupId: 'room' },
            participation: 'player',
            joinCode: null,
            preserveCurrentMembership: true
        });
        const delayed = Promise.withResolvers<TournamentSnapshot>();
        const canonical = test.owner.getState().view!;
        test.api.read.mockReturnValueOnce(delayed.promise);
        const pendingEntry = test.owner.enter('semifinal-1');
        test.entry.enter({ intent: 'join', roomRef: { ...scope, groupId: 'newer-user-choice' }, participation: 'player', joinCode: null });
        delayed.resolve(canonical);
        await pendingEntry;
        expect(test.entry.getState().destination?.roomRef.groupId).toBe('newer-user-choice');
        expect(test.owner.getState().error).toContain('room choice changed');
        test.api.read.mockRejectedValueOnce(new Error('Bracket refresh unavailable'));
        await test.owner.enter('semifinal-1');
        expect(test.owner.getState().error).toBe('Bracket refresh unavailable');
        expect(test.entry.getState().destination?.roomRef.groupId).toBe('newer-user-choice');
        await test.owner.refresh();
        apply({
            type: 'schedule',
            slot: 'semifinal-1',
            attemptId: 'replacement',
            roomId: 'replacement-room',
            gameId: 'replacement-room',
            scheduledAtEpochMs: 1000
        });
        test.snapshot({ ref, principalId: 'alice', observedAtEpochMs: 1000, listing: 'unlisted', tournament });
        await test.owner.enter('semifinal-1');
        expect(test.owner.getState().error).toContain('rescheduled');
        expect(test.entry.getState().destination?.roomRef.groupId).toBe('newer-user-choice');
        apply({ type: 'cancel' });
        test.snapshot({ ref, principalId: 'alice', observedAtEpochMs: 1000, listing: 'unlisted', tournament });
        await test.owner.enter('semifinal-1');
        expect(test.owner.getState().error).toContain('not available');
        expect(test.entry.getState().destination?.roomRef.groupId).toBe('newer-user-choice');
    });
});

function createScheduledTournament(scheduledAtEpochMs: number): Tournament {
    let state = createTournament({ ref, title: 'Cup', organizerPrincipalId: 'alice', rulesId: 'native-v1', createdAtEpochMs: 1, noShowGraceMs: 600000 });
    for (const actorPrincipalId of ['alice', 'bob', 'carol', 'dave']) {
        state = computeTournament({ state, command: { type: 'register' }, actorPrincipalId, nowEpochMs: 1000, results: [] }).state;
    }
    state = computeTournament({ state, command: { type: 'launch' }, actorPrincipalId: 'alice', nowEpochMs: 1000, results: [] }).state;
    return computeTournament({
        state,
        command: { type: 'schedule', slot: 'semifinal-1', attemptId: 'attempt', roomId: 'room', gameId: 'room', scheduledAtEpochMs },
        actorPrincipalId: 'alice',
        nowEpochMs: 1000,
        results: []
    }).state;
}

function createTournamentRoomEntry(): RallarRoomEntry {
    const saved = new Map<string, string>();
    return new RallarRoomEntry({
        auth: { session: () => session, onChange: () => () => {} },
        rooms: {
            onChange: () => () => {},
            join: async () => {
                throw new Error('No admission is requested in this owner test');
            }
        },
        storage: {
            getItem: (key) => saved.get(key) ?? null,
            setItem: (key, value) => {
                saved.set(key, value);
            },
            removeItem: (key) => {
                saved.delete(key);
            }
        },
        location: { read: () => 'https://game.example/', replace: () => {}, onChange: () => () => {} }
    }, { scope });
}
