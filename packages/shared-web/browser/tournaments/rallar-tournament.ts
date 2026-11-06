import type { StateScope } from '@shared/api/state-types.ts';
import { decodeTournamentRef } from '@shared/api/tournaments/decode-tournament-match-binding.ts';
import {
    decodeTournamentMutationResult,
    type TournamentMutationResult
} from '@shared/api/tournaments/tournament-mutation-result.ts';
import { decodeTournamentRequest, type TournamentRequest } from '@shared/api/tournaments/tournament-request.ts';
import { decodeTournamentSnapshot, type TournamentSnapshot } from '@shared/api/tournaments/tournament-snapshot.ts';
import type { TournamentMatch, TournamentRef } from '@shared/api/tournaments/tournament-types.ts';
import { jsonEquals } from '@shared/repository/state-utils.ts';
import { SubscriptionScope } from '@shared/resilience/subscription-scope.ts';
import { createDefaultTimers } from '@shared/resilience/timers.ts';
import { toError } from '@shared/resilience/to-error.ts';
import { AuthenticatedResource } from '../api/authenticated-resource.ts';
import { SelectedViewWatch } from '../api/selected-view-watch.ts';
import { subscribeViewDeadline } from '../api/subscribe-view-deadline.ts';
import { subscribeViewInvalidations } from '../api/subscribe-view-invalidations.ts';
import type { SubscribeViewRecovery } from '../api/subscribe-view-recovery.ts';
import { writeSelectedViewWatch } from '../api/write-selected-view-watch.ts';
import { toAuthSessionKey } from '../auth/to-auth-session-key.ts';
import { BrowserActivity } from '../browser-activity.ts';
import type { RallarConnectionOperations } from '../rallar-connection-facade.ts';
import type { RallarRoomEntry } from '../rooms/entry/rallar-room-entry.ts';
import { requireOwnWsConnectionGenerationId } from '../rooms/require-own-ws-connection-generation-id.ts';
import { tournamentHttpApi } from './tournament-http-api.ts';

export namespace RallarTournament {
    export interface ReadInput extends AuthenticatedResource.ReadInput {
        readonly ref: TournamentRef;
    }
    export interface ChangeInput extends AuthenticatedResource.ChangeInput<TournamentRequest> {
        readonly ref: TournamentRef;
    }
    export interface Api {
        read(input: ReadInput): Promise<TournamentSnapshot>;
        change(input: ChangeInput): Promise<TournamentMutationResult>;
    }
    export interface Dependencies extends AuthenticatedResource.Dependencies {
        readonly api: Api;
        readonly watch: Pick<SelectedViewWatch, 'select' | 'release'>;
        onChanged(listener: () => Promise<void>): () => void;
        readConnectionGeneration(signal: AbortSignal): Promise<string>;
        readonly entry: Pick<RallarRoomEntry, 'enter' | 'getState'>;
    }
    export interface Config {
        readonly scope: StateScope;
        readonly tournamentId: string;
    }
}

/** One selected bracket and its exact user intents; RoomEntry and game owners retain admission and gameplay. */
export class RallarTournament extends AuthenticatedResource<TournamentSnapshot, TournamentRequest> {
    readonly ref: TournamentRef;
    private readonly entry: Pick<RallarRoomEntry, 'enter' | 'getState'>;
    private readonly tournamentDependencies: RallarTournament.Dependencies;

    static createBrowser(
        browser:
            & SubscribeViewRecovery.Browser
            & Pick<RallarRoomEntry.Browser, 'auth'>
            & Pick<RallarConnectionOperations, 'connect'>,
        entry: RallarRoomEntry,
        config: RallarTournament.Config
    ): RallarTournament {
        return new RallarTournament({
            auth: {
                session: () => browser.session(),
                onChange: (listener, options) => browser.auth.onChange(listener, options)
            },
            api: tournamentHttpApi,
            onChanged: (changed) =>
                subscribeViewInvalidations({ browser, scope: config.scope, resource: 'tournament', changed }),
            watch: new SelectedViewWatch({
                createId: () => crypto.randomUUID(),
                change: (input) => writeSelectedViewWatch({ ...config.scope, family: 'tournament' }, input)
            }),
            readConnectionGeneration: async (signal) => {
                const context = await browser.connect({ scope: config.scope, signal });
                return await requireOwnWsConnectionGenerationId(context, signal);
            },
            entry,
            activity: new BrowserActivity(),
            timers: createDefaultTimers(),
            createId: () => crypto.randomUUID()
        }, config);
    }

    constructor(dependencies: RallarTournament.Dependencies, config: RallarTournament.Config) {
        const ref = decodeTournamentRef({ ...config.scope, tournamentId: config.tournamentId });
        super(dependencies, {
            scope: config.scope,
            changeResult: 'read',
            subscribeRefresh: (refresh) => this.subscribeRefresh(refresh)
        }, {
            async read(attempt) {
                const connectionGenerationId = await dependencies.readConnectionGeneration(attempt.signal);
                attempt.signal.throwIfAborted();
                await dependencies.watch.select({ ...attempt, resourceId: ref.tournamentId, connectionGenerationId });
                attempt.signal.throwIfAborted();
                const snapshot = decodeTournamentSnapshot(await dependencies.api.read({ ...attempt, ref }));
                if (!jsonEquals(snapshot.ref, ref) || snapshot.principalId !== attempt.session.clientId) {
                    throw new TypeError('Tournament response belongs to another account or tournament');
                }
                return snapshot;
            },
            async change(attempt) {
                const request = decodeTournamentRequest(attempt.request);
                const result = decodeTournamentMutationResult(
                    await dependencies.api.change({ ...attempt, ref, request }),
                    { ref, requestId: attempt.requestId }
                );
                return result.code === null ? null : tournamentRefusalMessage(result.code);
            }
        });
        this.ref = ref;
        this.entry = dependencies.entry;
        this.tournamentDependencies = dependencies;
    }

    private subscribeRefresh(refresh: () => Promise<void>): () => void {
        const dependencies = this.tournamentDependencies;
        const subscriptions = new SubscriptionScope();
        let key = this.watchAccountKey();
        subscriptions.add(dependencies.auth.onChange(() => {
            const next = this.watchAccountKey();
            if (next !== key) {
                key = next;
                this.releaseWatch();
            }
        }, { emitCurrent: false }));
        subscriptions.add(dependencies.onChanged(refresh));
        subscriptions.add(subscribeViewDeadline<TournamentSnapshot>({
            onChange: (listener) => this.onChange(listener),
            timers: dependencies.timers,
            remainingMs: tournamentStartDelay,
            refresh
        }));
        subscriptions.add(() => this.releaseWatch());
        return () => subscriptions.unsubscribe();
    }

    private watchAccountKey(): string | null {
        const session = this.tournamentDependencies.auth.session();
        return session === undefined ? null : toAuthSessionKey(session);
    }

    private releaseWatch(): void {
        void this.tournamentDependencies.watch.release().catch((error) => {
            console.error('Tournament watch cleanup failed', toError(error));
        });
    }

    async enter(slot: TournamentMatch['slot']): Promise<void> {
        const roomChoice = this.entry.getState();
        const attempt = this.beginOperation();
        if (attempt === null) {
            return;
        }
        const previous = this.getState().view?.tournament?.matches.find((match) => match.slot === slot)?.attempt;
        try {
            await this.refresh();
            if (!this.current(attempt)) {
                return;
            }
            if (this.entry.getState() !== roomChoice) {
                this.setError('Your room choice changed. Choose Enter again if you still want this match.');
                return;
            }
            const snapshot = this.getState().view;
            if (snapshot === null) {
                return;
            }
            const match = snapshot.tournament?.matches.find((match) => match.slot === slot);
            if (previous && match?.attempt && previous.binding.attemptId !== match.attempt.binding.attemptId) {
                this.setError('This match was rescheduled. Review its current attempt before entering.');
                return;
            }
            if (
                !match?.attempt || match.attempt.startedAtEpochMs === null ||
                !['playing', 'complete'].includes(match.status)
            ) {
                this.setError('This match is not available to enter. Review the current bracket.');
                return;
            }
            this.entry.enter({
                intent: 'join',
                roomRef: match.attempt.binding.roomRef,
                participation: match.attempt.binding.principalIds.includes(attempt.session.clientId)
                    ? 'player'
                    : 'spectator',
                joinCode: null,
                preserveCurrentMembership: true
            });
        }
        catch (error) {
            if (this.current(attempt)) {
                this.setError(toError(error).message);
            }
        }
        finally {
            this.finishOperation(attempt);
        }
    }
}

/** Starting is authorized against server time; a future schedule requires one canonical observation at its boundary. */
function tournamentStartDelay(snapshot: TournamentSnapshot): number | null {
    if (snapshot.tournament?.status !== 'active') {
        return null;
    }
    const starts = snapshot.tournament.matches.flatMap((match) =>
        match.status === 'scheduled' && match.attempt !== null &&
            match.attempt.scheduledAtEpochMs > snapshot.observedAtEpochMs
            ? [match.attempt.scheduledAtEpochMs]
            : []
    );
    return starts.length === 0 ? null : Math.min(...starts) - snapshot.observedAtEpochMs;
}

function tournamentRefusalMessage(code: string): string {
    const messages: Readonly<Record<string, string>> = {
        unauthorized: 'Sign in again to continue.',
        'authentication-required': 'Sign in again to continue.',
        'organizer-required': 'Only the organizer can do that.',
        'unsupported-game': 'Tournaments are not enabled on this game server.',
        'unsupported-rules': 'This server does not support the tournament rules.',
        'tournament-not-found': 'This tournament could not be found.',
        'tournament-exists': 'This tournament already exists. Refresh its bracket.',
        'tournament-full': 'All four tournament places are taken.',
        'registration-closed': 'Registration has closed.',
        'four-entrants-required': 'Four registered players are required to launch.',
        'not-an-entrant': 'Register before withdrawing from this tournament.',
        'entrant-withdrawn': 'A competitor withdrew. Review the bracket before continuing.',
        'both-check-ins-required': 'Both competitors must check in before the organizer starts.',
        'check-in-session-expired': 'A competitor must sign in and check in again.',
        'admission-denied': 'The match room could not admit both competitors. Check their room access.',
        'before-start': 'The scheduled start time has not arrived.',
        'schedule-in-past': 'Choose a future start time.',
        'not-a-competitor': 'Only this match’s competitors can check in.',
        'stale-attempt': 'This match was rescheduled. Check in to the current attempt.',
        'tournament-finished': 'This tournament has ended.'
    };
    return messages[code] ?? 'The bracket changed. Refresh it before trying that action again.';
}
