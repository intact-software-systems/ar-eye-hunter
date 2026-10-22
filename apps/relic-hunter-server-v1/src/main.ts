import { loadSync } from '@std/dotenv';
import { Hono, type Context } from 'hono';

import { createDefaultRallarServer } from '@api-v1/src/composition/create-default-rallar-server.ts';
import { createDefaultApiV1DatabaseLifecycle } from '@api-v1/src/db/api-v1-database-lifecycle.ts';
import { installApiHttpMiddleware } from '@api-v1/src/services/install-api-http-middleware.ts';
import { requireApiAuthSession, toAuthErrorResponse } from '@api-v1/src/services/request-auth-service.ts';
import { createApiTimingSink } from '@api-v1/src/services/timing-service.ts';
import { isRelicCommand, toRelicRoomGroupRef } from '@relic-hunters/mod.ts';
import { isGroupPolicyDeniedError } from '@shared-server/rallar-system/group-state/policy/group-policy-result.ts';
import type { ApiConfigResponse } from '@shared/api/api-config.ts';
import type { GroupSnapshot } from '@shared/api/group-types.ts';
import { toError } from '@shared/resilience/to-error.ts';

import { initRelicDocsLandingRoute } from './relic-docs-landing-route.ts';
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
    hardwareConcurrency: navigator.hardwareConcurrency,
    readTextFile: Deno.readTextFile,
    defaultsUrl: new URL('../../api-v1/resources/configuration/defaults-config.json', import.meta.url),
    profileUrls: {
        dev: new URL('../../api-v1/resources/configuration/dev-config.json', import.meta.url),
        prod: new URL('../../api-v1/resources/configuration/prod-config.json', import.meta.url),
        'prod-hardened': new URL('../../api-v1/resources/configuration/prod-hardened-config.json', import.meta.url),
        'prod-in-memory': new URL('../../api-v1/resources/configuration/prod-in-memory-config.json', import.meta.url)
    },
    staticClientsUrl: new URL('../../api-v1/resources/authorised-clients.json', import.meta.url),
    relicDefaultsUrl: new URL('../resources/configuration/defaults-config.json', import.meta.url),
    relicProfileUrls: {
        prod: new URL('../resources/configuration/prod-config.json', import.meta.url),
        'prod-hardened': new URL('../resources/configuration/prod-hardened-config.json', import.meta.url)
    }
});
const databaseLifecycle = await createDefaultApiV1DatabaseLifecycle({
    database: configuration.apiV1.database,
    pgliteEvidence: configuration.apiV1.blackBox.pgliteEvidence,
    statementCensus: undefined
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
        onFallback: (event) => {
            console.warn(
                `[relic-ai] expedition generation fell back for ${event.gameId}: ${event.error}`
            );
        }
    }),
    readSession: (sessionId) => rallar.runtime.authSessionRepository.findBySessionId(sessionId)
});

installApiHttpMiddleware(app, {
    http: configuration.http,
    stateApi: configuration.apiV1.stateApi,
    timing: createApiTimingSink(configuration.apiV1.observability)
});

app.get(
    '/api/config',
    (c) =>
        c.json(
            {
                ...configuration.browser,
                serverPeerId: rallar.ws.serverPeerId
            } satisfies ApiConfigResponse
        )
);

initRelicDocsLandingRoute(app);
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
        return relicRestErrorResponse(c, toError(error));
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
        };

        if (!isRelicCommand(command)) {
            return c.json({ error: 'Invalid relic command' }, 400);
        }

        return c.json(await relicGame.applyCommand(command, session));
    }
    catch (error) {
        return relicRestErrorResponse(c, toError(error));
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
        return relicRestErrorResponse(c, toError(error));
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

async function readRelicGroupSnapshotForPolicy(
    gameId: string
): Promise<GroupSnapshot | undefined> {
    if (configuration.restAuthorization.mode === 'authenticated') {
        return undefined;
    }

    return await rallar.runtime.groupStateService.readSnapshot(toRelicRoomGroupRef(gameId));
}

function relicRestErrorResponse(c: Context, error: Error): Response {
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
