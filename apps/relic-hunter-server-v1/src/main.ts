import { loadSync } from '@std/dotenv';
import { Hono } from 'hono';

import { createDefaultRallarServer } from '@api-v1/src/composition/create-default-rallar-server.ts';
import { reportApiV1Configuration } from '@api-v1/src/configuration/report-api-v1-configuration.ts';
import { createDefaultApiV1DatabaseLifecycle } from '@api-v1/src/db/api-v1-database-lifecycle.ts';
import { myServerId } from '@api-v1/src/runtime/runtime-identity.ts';
import { installApiHttpMiddleware } from '@api-v1/src/services/install-api-http-middleware.ts';
import { createApiTimingSink } from '@api-v1/src/services/timing-service.ts';
import type { ApiConfigResponse } from '@shared/api/api-config.ts';

import { createRelicGameServices } from './create-relic-game-services.ts';
import { initRelicDocsLandingRoute } from './relic-docs-landing-route.ts';
import { createRelicExpeditionInitialStateFactory } from './relic-expedition-ai.ts';
import { initRelicGameRoutes } from './relic-game-routes.ts';
import { installRelicHunterGame } from './relic-game-service.ts';
import { readRelicHunterServerConfiguration } from './relic-hunter-server-configuration.ts';
import { installRelicPlanningAiTopic } from './relic-planning-ai-topic.ts';
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
reportApiV1Configuration(configuration.apiV1, console);
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
const relicServices = createRelicGameServices({
    database: databaseLifecycle.database,
    groups: rallar.runtime.groupsRepository,
    sessions: rallar.runtime.authSessionRepository,
    appInbox: rallar.appInbox,
    roomOwnedAppDataBindings: configuration.apiV1.group.roomOwnedAppDataBindings,
    serviceId: myServerId,
    wsRuntimeName: rallar.ws.serverPeerId,
    wakeQueue: () => rallar.runtime.qboxEngine.wake(),
    nowEpochMs: Date.now,
    timing: createApiTimingSink(configuration.apiV1.observability)
});
const relicGame = installRelicHunterGame(rallar, {
    mode: configuration.restAuthorization.mode,
    inbox: relicServices.relicGameInboxService,
    mutations: relicServices.relicGameMutations,
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
installRelicPlanningAiTopic({ websocket: rallar.ws, serverSenderId: rallar.ws.serverPeerId });

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

initRelicGameRoutes(app, { relicGame, sessions: rallar.runtime.authSessionRepository });

rallar.installSystemTopics();
rallar.installWebSocketLifecycle();
rallar.mountWebSocket(app);
rallar.mountRest(app);
rallar.start({ queueWorkers: configuration.apiV1.topology.replay.queueWorkers });

Deno.serve({ port: configuration.http.port }, app.fetch);
console.log(`Relic Hunter server started on port ${configuration.http.port}.`);

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
