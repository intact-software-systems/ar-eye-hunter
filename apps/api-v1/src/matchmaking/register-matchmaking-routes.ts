import type { IssuedAuthSession } from '@shared-server/rallar-system/auth/persistence/auth-session-types.ts';
import type { MatchmakingReader } from '@shared-server/rallar-system/matchmaking/matchmaking-reader.ts';
import type { MatchmakingService } from '@shared-server/rallar-system/matchmaking/matchmaking-service.ts';
import type { RateLimiterPolicy } from '@shared/resilience/rate-limiter.ts';
import type { Hono } from 'jsr:@hono/hono@4.11.9';
import { readMatchmaking } from './read-matchmaking.ts';
import { changeMatchmaking } from './change-matchmaking.ts';

export interface MatchmakingRouteDependencies {
    readonly reader: Pick<MatchmakingReader, 'read'>;
    readonly mutation: Pick<MatchmakingService['mutate'], 'submit'>;
    readonly mutationQuota: RateLimiterPolicy;
    requireSession(request: { header(name: string): string | undefined; }): Promise<IssuedAuthSession>;
}

export function registerMatchmakingRoutes(app: Hono, dependencies: MatchmakingRouteDependencies): void {
    app.get(
        '/api/matchmaking/apps/:applicationId/workspaces/:workspaceId',
        (context) => readMatchmaking(context, dependencies)
    );
    app.post(
        '/api/matchmaking/apps/:applicationId/workspaces/:workspaceId/requests/:requestId',
        (context) => changeMatchmaking(context, dependencies)
    );
}
