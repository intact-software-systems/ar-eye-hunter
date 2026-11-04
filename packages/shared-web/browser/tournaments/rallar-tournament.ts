import { decodeTournamentRef } from '@shared/api/tournaments/decode-tournament-match-binding.ts';
import {
    decodeTournamentMutationResult,
    type TournamentMutationResult
} from '@shared/api/tournaments/tournament-mutation-result.ts';
import { decodeTournamentRequest, type TournamentRequest } from '@shared/api/tournaments/tournament-request.ts';
import { decodeTournamentSnapshot, type TournamentSnapshot } from '@shared/api/tournaments/tournament-snapshot.ts';
import type { TournamentMatch, TournamentRef } from '@shared/api/tournaments/tournament-types.ts';
import { jsonEquals } from '@shared/repository/state-utils.ts';
import { createDefaultTimers } from '@shared/resilience/timers.ts';
import { toError } from '@shared/resilience/to-error.ts';
import { AuthenticatedResource } from '../api/authenticated-resource.ts';
import { BrowserActivity } from '../browser-activity.ts';
import type { RallarRoomEntry } from '../rooms/entry/rallar-room-entry.ts';
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
        readonly entry: Pick<RallarRoomEntry, 'enter'>;
    }
    export interface Config extends AuthenticatedResource.Config {
        readonly tournamentId: string;
    }
}

/** One selected bracket and its exact user intents; RoomEntry and game owners retain admission and gameplay. */
export class RallarTournament extends AuthenticatedResource<TournamentSnapshot, TournamentRequest> {
    readonly ref: TournamentRef;
    private readonly entry: Pick<RallarRoomEntry, 'enter'>;

    static createBrowser(
        browser: Pick<RallarRoomEntry.Browser, 'auth' | 'session'>,
        entry: RallarRoomEntry,
        config: RallarTournament.Config
    ): RallarTournament {
        return new RallarTournament({
            auth: {
                session: () => browser.session(),
                onChange: (listener, options) => browser.auth.onChange(listener, options)
            },
            api: tournamentHttpApi,
            entry,
            activity: new BrowserActivity(),
            timers: createDefaultTimers(),
            createId: () => crypto.randomUUID()
        }, config);
    }

    constructor(dependencies: RallarTournament.Dependencies, config: RallarTournament.Config) {
        const ref = decodeTournamentRef({ ...config.scope, tournamentId: config.tournamentId });
        super(dependencies, config, {
            async read(attempt) {
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
    }

    async enter(slot: TournamentMatch['slot']): Promise<void> {
        const attempt = this.beginOperation();
        if (attempt === null) {
            return;
        }
        try {
            await this.refresh();
            const match = this.getState().view?.tournament?.matches.find((match) => match.slot === slot);
            if (
                this.current(attempt) && match?.attempt && match.attempt.startedAtEpochMs !== null &&
                (match.status === 'playing' || match.status === 'complete')
            ) {
                const participation = match.attempt.binding.principalIds.includes(attempt.session.clientId)
                    ? 'player'
                    : 'spectator';
                this.entry.enter({
                    intent: 'join',
                    roomRef: match.attempt.binding.roomRef,
                    participation,
                    joinCode: null,
                    preserveCurrentMembership: true
                });
            }
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
