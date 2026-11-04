import type { RallarServerAppInbox } from '@shared-server/rallar-server/rallar-server-app-inbox.ts';
import type { IssuedAuthSession } from '@shared-server/rallar-system/auth/persistence/auth-session-types.ts';
import type { TournamentReader } from '@shared-server/rallar-system/tournaments/tournament-reader.ts';
import type { TournamentService } from '@shared-server/rallar-system/tournaments/tournament-service.ts';
import type { TournamentMutationResult } from '@shared/api/tournaments/tournament-mutation-result.ts';
import type { RateLimiterPolicy } from '@shared/resilience/rate-limiter.ts';
import type { Hono } from 'jsr:@hono/hono@4.11.9';
import { changeTournament } from './change-tournament.ts';
import { readTournament } from './read-tournament.ts';

export interface TournamentRouteDependencies {
    readonly reader: Pick<TournamentReader, 'read'>;
    readonly mutation: Pick<
        RallarServerAppInbox.Operation<TournamentService.Command, TournamentMutationResult>,
        'submit'
    >;
    readonly mutationQuota: RateLimiterPolicy;
    requireSession(request: { header(name: string): string | undefined; }): Promise<IssuedAuthSession>;
}

export function registerTournamentRoutes(app: Hono, dependencies: TournamentRouteDependencies): void {
    const path = '/api/tournaments/apps/:applicationId/workspaces/:workspaceId/tournaments/:tournamentId';
    app.get(path, (context) => readTournament(context, dependencies));
    app.post(`${path}/requests/:requestId`, (context) => changeTournament(context, dependencies));
}
