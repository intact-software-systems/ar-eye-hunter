import type { Context, Hono } from 'hono';

import { readApiRequestTraceId } from '@api-v1/src/services/read-api-request-trace-id.ts';
import { requireApiAuthSession, toAuthErrorResponse } from '@api-v1/src/services/request-auth-service.ts';
import { RelicGameInboxFailureError } from '@relic-hunters/server/relic-game-inbox-service.ts';
import { isRelicGameMoveInput } from '@relic-hunters/server/relic-game-move.ts';
import { RelicGameMutationRefusedError } from '@relic-hunters/server/relic-game-mutation-service.ts';
import type { AuthSessionRepository } from '@shared-server/rallar-system/auth/persistence/auth-session-repository.ts';
import { toError } from '@shared/resilience/to-error.ts';

import type { RelicHunterGameService } from './relic-game-service.ts';

export interface RelicGameRoutesDependencies {
    readonly relicGame: Pick<RelicHunterGameService, 'readSnapshot' | 'ensureSnapshot' | 'applyCommand' | 'reset'>;
    readonly sessions: AuthSessionRepository;
}

/** The API timing middleware runs outermost on `/api/*`, so every route reads the request's `x-request-id` trace. */
export function initRelicGameRoutes(app: Hono, dependencies: RelicGameRoutesDependencies): Hono {
    app.use('/api/relic/*', async (c, next) => {
        try {
            await requireApiAuthSession(c.req, dependencies.sessions);
            await next();
        }
        catch (error) {
            return toAuthErrorResponse(c, error);
        }
    });
    registerRelicSnapshotRoute(app, dependencies);
    registerRelicInitializeRoute(app, dependencies);
    registerRelicCommandRoute(app, dependencies);
    registerRelicResetRoute(app, dependencies);
    return app;
}

function registerRelicSnapshotRoute(app: Hono, { relicGame, sessions }: RelicGameRoutesDependencies): void {
    app.get('/api/relic/games/:gameId', async (c) => {
        try {
            const request = await readRelicRestRequest(c, sessions, crypto.randomUUID());
            const snapshot = await relicGame.readSnapshot(c.req.param('gameId'), request);
            return snapshot === null ? c.body(null, 204) : c.json(snapshot);
        }
        catch (error) {
            return toRelicRestErrorResponse(c, toError(error));
        }
    });
}

function registerRelicInitializeRoute(app: Hono, { relicGame, sessions }: RelicGameRoutesDependencies): void {
    app.post('/api/relic/games/:gameId/initialize/requests/:requestId', async (c) => {
        try {
            const request = await readRelicRestRequest(c, sessions, c.req.param('requestId'));
            return c.json(await relicGame.ensureSnapshot(c.req.param('gameId'), request));
        }
        catch (error) {
            return toRelicRestErrorResponse(c, toError(error));
        }
    });
}

function registerRelicCommandRoute(app: Hono, { relicGame, sessions }: RelicGameRoutesDependencies): void {
    app.post('/api/relic/games/:gameId/commands/requests/:requestId', async (c) => {
        try {
            const request = await readRelicRestRequest(c, sessions, c.req.param('requestId'));
            const body = await c.req.json().catch(() => undefined);
            const command = {
                ...(typeof body === 'object' && body !== null ? body : {}),
                gameId: c.req.param('gameId'),
                username: request.session.username
            };
            if (!isRelicGameMoveInput(command)) {
                return c.json({ error: 'Invalid relic command' }, 400);
            }
            return c.json(await relicGame.applyCommand(command, request));
        }
        catch (error) {
            return toRelicRestErrorResponse(c, toError(error));
        }
    });
}

function registerRelicResetRoute(app: Hono, { relicGame, sessions }: RelicGameRoutesDependencies): void {
    app.post('/api/relic/games/:gameId/reset/requests/:requestId', async (c) => {
        try {
            const request = await readRelicRestRequest(c, sessions, c.req.param('requestId'));
            return c.json(await relicGame.reset(c.req.param('gameId'), request));
        }
        catch (error) {
            return toRelicRestErrorResponse(c, toError(error));
        }
    });
}

async function readRelicRestRequest(
    c: Context,
    sessions: AuthSessionRepository,
    requestId: string
): Promise<RelicHunterGameService.RestRequest> {
    return {
        session: await requireApiAuthSession(c.req, sessions),
        requestId,
        traceId: readApiRequestTraceId(c)
    };
}

function toRelicRestErrorResponse(c: Context, error: Error): Response {
    if (error instanceof RelicGameMutationRefusedError) {
        return c.json({ status: 'refused', error: error.message, code: error.result.code }, error.result.httpStatus);
    }
    if (error instanceof RelicGameInboxFailureError) {
        return Response.json({ error: error.message, code: error.failure.code }, { status: error.failure.status });
    }
    return toAuthErrorResponse(c, error);
}
