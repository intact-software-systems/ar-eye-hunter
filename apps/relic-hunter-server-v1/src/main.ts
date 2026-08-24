import { loadSync } from '@std/dotenv';
import { Hono, type Context } from 'hono';
import { cors } from 'hono/cors';

import { createDefaultRallarServer } from '@api-v1/src/composition/create-default-rallar-server.ts';
import { createApiV1DatabaseLifecycle } from '@api-v1/src/db/api-v1-database-lifecycle.ts';
import { requireApiAuthSession, toAuthErrorResponse } from '@api-v1/src/services/request-auth-service.ts';
import { isRelicCommand, type RelicCommand } from '@relic-hunters/mod.ts';
import { isGroupPolicyDeniedError } from '@shared-server/rallar-system/group-state/policy/group-policy-result.ts';
import type { GroupSnapshot } from '@shared/api/group-types.ts';
import { DEFAULT_STATE_APPLICATION_ID, DEFAULT_STATE_WORKSPACE_ID } from '@shared/api/state-types.ts';
import { createRelicExpeditionInitialStateFactory } from './relic-expedition-ai.ts';
import { installRelicHunterGame } from './relic-game-service.ts';
import { readRelicHunterServerConfiguration } from './relic-hunter-server-configuration.ts';
import {
    authorizeRelicCommand,
    authorizeRelicReset,
    authorizeRelicSnapshotRead,
    RelicRestGroupNotFoundError
} from './relic-rest-auth.ts';
import { initRelicSwaggerRoutes } from './relic-swagger-routes.ts';

loadEnvironment();

const app: Hono = new Hono();
const configuration = await readRelicHunterServerConfiguration({
    environment: Deno.env,
    readTextFile: Deno.readTextFile,
    defaultsUrl: new URL('../../api-v1/resources/configuration/defaults-config.json', import.meta.url),
    profileUrls: {
        dev: new URL('../../api-v1/resources/configuration/dev-config.json', import.meta.url),
        prod: new URL('../../api-v1/resources/configuration/prod-config.json', import.meta.url),
        'prod-in-memory': new URL('../../api-v1/resources/configuration/prod-in-memory-config.json', import.meta.url)
    },
    staticClientsUrl: new URL('../../api-v1/resources/authorised-clients.json', import.meta.url)
});
const databaseLifecycle = await createApiV1DatabaseLifecycle({
    database: configuration.apiV1.database,
    pgliteEvidence: configuration.apiV1.blackBox.pgliteEvidence
});
const rallar = await createDefaultRallarServer({
    configuration: configuration.apiV1,
    databaseLifecycle,
    ws: {
        allowImplicitUserTopics: false,
        defaultFanout: 'live-only'
    }
});
addEventListener('unload', () => {
    void rallar.runtime.backgroundTasks.stop().catch((error) => {
        console.error('Failed to stop embedded API-v1 resources:', error);
    });
});
const relicGame = await installRelicHunterGame(rallar, {
    createInitialState: createRelicExpeditionInitialStateFactory({
        configuration: configuration.expeditionAi,
        rallar,
        onFallback: (event) => {
            console.warn(
                `[relic-ai] expedition generation fell back for ${event.gameId}: ${event.error}`
            );
        }
    })
});

const apiCors = cors({
    origin: (origin) => resolveCorsOrigin(origin, configuration.http.corsOrigins),
    allowMethods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    allowHeaders: ['Content-Type', 'Authorization', 'x-client-id'],
    exposeHeaders: ['Content-Length'],
    maxAge: configuration.http.preflightMaxAgeSeconds,
    credentials: true
});

app.use('/api/*', async (c, next) => {
    if (isWebSocketUpgradeRequest(c.req.path, c.req.header('upgrade'))) {
        await next();
        return;
    }

    return await apiCors(c, next);
});

app.get('/api/config', (c) => c.json(configuration.browser));

initRelicSwaggerRoutes(app);

app.use('/api/relic/*', async (c, next) => {
    try {
        await requireApiAuthSession(c.req, rallar.runtime.authSessionRepository);
        await next();
    }
    catch (error) {
        return toAuthErrorResponse(c, error);
    }
});

app.get('/api/relic/games/:gameId', async (c) => {
    try {
        const gameId = c.req.param('gameId');
        const session = await requireApiAuthSession(c.req, rallar.runtime.authSessionRepository);
        authorizeRelicSnapshotRead({
            mode: configuration.restAuthorization.mode,
            gameId,
            session,
            snapshot: await readRelicGroupSnapshotForPolicy(gameId)
        });
        return c.json(await relicGame.ensureSnapshot(gameId));
    }
    catch (error) {
        return relicRestErrorResponse(c, error);
    }
});

app.post('/api/relic/games/:gameId/commands', async (c) => {
    try {
        const gameId = c.req.param('gameId');
        const session = await requireApiAuthSession(c.req, rallar.runtime.authSessionRepository);
        authorizeRelicCommand({
            mode: configuration.restAuthorization.mode,
            gameId,
            session,
            snapshot: await readRelicGroupSnapshotForPolicy(gameId)
        });
        const body = await c.req.json().catch(() => undefined);
        const command = {
            ...(typeof body === 'object' && body !== null ? body : {}),
            gameId,
            username: session.username
        } as RelicCommand;

        if (!isRelicCommand(command)) {
            return c.json({ error: 'Invalid relic command' }, 400);
        }

        return c.json(await relicGame.applyCommand(command, session.sessionId));
    }
    catch (error) {
        return relicRestErrorResponse(c, error);
    }
});

app.post('/api/relic/games/:gameId/reset', async (c) => {
    try {
        const gameId = c.req.param('gameId');
        const session = await requireApiAuthSession(c.req, rallar.runtime.authSessionRepository);
        authorizeRelicReset({
            mode: configuration.restAuthorization.mode,
            gameId,
            session,
            snapshot: await readRelicGroupSnapshotForPolicy(gameId)
        });
        const snapshot = await relicGame.reset(gameId);
        return c.json(snapshot);
    }
    catch (error) {
        return relicRestErrorResponse(c, error);
    }
});

rallar.installSystemTopics();
rallar.installWebSocketLifecycle();
rallar.mountWebSocket(app);
rallar.mountRest(app);
if (configuration.apiV1.topology.replay.queueWorkers === 'enabled') {
    rallar.start();
}

Deno.serve({ port: configuration.http.port }, app.fetch);
console.log(`Relic Hunter server started on port ${configuration.http.port}.`);

function resolveCorsOrigin(
    origin: string,
    allowedOrigins: readonly string[]
): string | undefined {
    if (allowedOrigins.includes('*')) {
        return origin || undefined;
    }

    return allowedOrigins.includes(origin) ? origin : undefined;
}

function isWebSocketUpgradeRequest(path: string, upgrade?: string): boolean {
    return path.startsWith('/api/ws/') && upgrade?.trim().toLowerCase() === 'websocket';
}

async function readRelicGroupSnapshotForPolicy(
    gameId: string
): Promise<GroupSnapshot | undefined> {
    if (configuration.restAuthorization.mode === 'authenticated') {
        return undefined;
    }

    return await rallar.runtime.groupStateService.readSnapshot({
        applicationId: DEFAULT_STATE_APPLICATION_ID,
        workspaceId: DEFAULT_STATE_WORKSPACE_ID,
        groupId: gameId
    });
}

function relicRestErrorResponse(c: Context, error: unknown): Response {
    if (error instanceof RelicRestGroupNotFoundError) {
        return c.json({ error: error.message }, error.status);
    }

    if (isGroupPolicyDeniedError(error)) {
        return c.json({
            error: error.message,
            code: error.denial.code,
            details: error.denial.details
        }, error.status);
    }

    return toAuthErrorResponse(c, error);
}

function loadEnvironment(): void {
    loadEnvFileIfPresent(new URL('../.env', import.meta.url));
    loadEnvFileIfPresent(new URL('../.env.local', import.meta.url));
    loadEnvFileIfPresent(new URL('../../api-v1/.env', import.meta.url));
    loadEnvFileIfPresent(new URL('../../api-v1/.env.local', import.meta.url));
}

function loadEnvFileIfPresent(envPath: URL): void {
    try {
        loadSync({
            envPath,
            export: true
        });
    }
    catch (error) {
        if (error instanceof Deno.errors.NotFound) {
            return;
        }

        throw error;
    }
}
