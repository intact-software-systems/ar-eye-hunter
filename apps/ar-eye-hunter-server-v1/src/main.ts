import { bindTournamentGameProfile } from '@shared-server/rallar-system/tournaments/tournament-game-profile.ts';
import 'jsr:@std/dotenv@0.225.6/load';
import { createDefaultRallarServer } from '@api-v1/src/composition/create-default-rallar-server.ts';
import { readApiV1Configuration } from '@api-v1/src/configuration/read-api-v1-configuration.ts';
import { reportApiV1Configuration } from '@api-v1/src/configuration/report-api-v1-configuration.ts';
import { createDefaultApiV1DatabaseLifecycle } from '@api-v1/src/db/api-v1-database-lifecycle.ts';
import { myServerId } from '@api-v1/src/runtime/runtime-identity.ts';
import { serveApiApplication } from '@api-v1/src/runtime/serve-api-application.ts';
import { installApiHttpMiddleware } from '@api-v1/src/services/install-api-http-middleware.ts';
import { requireApiAuthSession } from '@api-v1/src/services/request-auth-service.ts';
import { createApiTimingSink } from '@api-v1/src/services/timing-service.ts';
import { AppTopics } from '@shared/api/api-config.ts';
import { Hono } from 'jsr:@hono/hono@4.11.9';
import { registerArenaTournamentRoutes } from './arena-tournament-routes.ts';
import {
    ARENA_TOURNAMENT_GAME_PROFILE,
    ARENA_TOURNAMENT_SNAPSHOT_PRODUCER,
    createArenaTournamentServices
} from './create-arena-tournament-services.ts';

const configured = await readApiV1Configuration({
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
    staticClientsUrl: new URL('../../api-v1/resources/authorised-clients.json', import.meta.url)
});
const configuration = {
    ...configured,
    tournaments: {
        ...configured.tournaments,
        profiles: bindTournamentGameProfile(configured.tournaments.profiles, ARENA_TOURNAMENT_GAME_PROFILE)
    }
};
reportApiV1Configuration(configuration, console);
const timing = createApiTimingSink(configuration.observability);
const databaseLifecycle = await createDefaultApiV1DatabaseLifecycle({
    database: configuration.database,
    pgliteEvidence: configuration.blackBox.pgliteEvidence,
    statementCensus: undefined
});
const rallar = await createDefaultRallarServer({ configuration, databaseLifecycle });
rallar.ws.defineTopic({
    topicId: AppTopics.serverRoomSnapshot,
    scope: 'room',
    fanout: 'live-only',
    participation: 'server',
    serverProducerIds: [ARENA_TOURNAMENT_SNAPSHOT_PRODUCER.producerId]
});
const services = createArenaTournamentServices({
    database: databaseLifecycle.database,
    groups: rallar.runtime.groupsRepository,
    sessions: rallar.runtime.authSessionRepository,
    appInbox: rallar.appInbox,
    ws: rallar.ws,
    registerStop: (stop) => rallar.runtime.backgroundTasks.register(stop),
    outbox: rallar.runtime.outboxQueueReader,
    bindings: configuration.group.roomOwnedAppDataBindings,
    serviceId: myServerId,
    nowEpochMs: Date.now
});
const app = new Hono();
installApiHttpMiddleware(app, { http: configuration.http, stateApi: configuration.stateApi, timing });
registerArenaTournamentRoutes(app, {
    ...services,
    nowEpochMs: Date.now,
    requireSession: (request) => requireApiAuthSession(request, rallar.runtime.authSessionRepository)
});
await serveApiApplication({ app, rallar, configuration });
console.log(`AR Eye Hunter server started on port ${configuration.http.port}.`);
