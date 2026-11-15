import { Hono } from 'hono';
import { readFile } from 'node:fs/promises';

import { createDefaultRallarServer } from '@api-v1/src/composition/create-default-rallar-server.ts';
import { readApiV1Configuration } from '@api-v1/src/configuration/read-api-v1-configuration.ts';
import { reportApiV1Configuration } from '@api-v1/src/configuration/report-api-v1-configuration.ts';
import { createDefaultApiV1DatabaseLifecycle } from '@api-v1/src/db/api-v1-database-lifecycle.ts';
import { myServerId } from '@api-v1/src/runtime/runtime-identity.ts';
import { serveApiApplication } from '@api-v1/src/runtime/serve-api-application.ts';
import { installApiHttpMiddleware } from '@api-v1/src/services/install-api-http-middleware.ts';
import { createApiTimingSink } from '@api-v1/src/services/timing-service.ts';

import { MarketAuthority } from './market-authority.ts';

const configuration = await readApiV1Configuration({
    environment: process.env,
    hardwareConcurrency: navigator.hardwareConcurrency,
    readTextFile: (url) => readFile(url, 'utf8'),
    defaultsUrl: new URL('../../api-v1/resources/configuration/defaults-config.json', import.meta.url),
    profileUrls: {
        dev: new URL('../../api-v1/resources/configuration/dev-config.json', import.meta.url),
        prod: new URL('../../api-v1/resources/configuration/prod-config.json', import.meta.url),
        'prod-hardened': new URL('../../api-v1/resources/configuration/prod-hardened-config.json', import.meta.url),
        'prod-in-memory': new URL('../../api-v1/resources/configuration/prod-in-memory-config.json', import.meta.url)
    },
    staticClientsUrl: new URL('../../api-v1/resources/authorised-clients.json', import.meta.url)
});
reportApiV1Configuration(configuration, console);
const timing = createApiTimingSink(configuration.observability);
const databaseLifecycle = await createDefaultApiV1DatabaseLifecycle({
    database: configuration.database,
    pgliteEvidence: configuration.blackBox.pgliteEvidence,
    statementCensus: configuration.observability.timingLogs ? { timing, serviceId: myServerId } : undefined
});
const rallar = await createDefaultRallarServer({
    configuration,
    databaseLifecycle
});
const app: Hono = new Hono();
const incarnation = crypto.randomUUID();
const market = new MarketAuthority({ ws: rallar.ws, now: Date.now, serverId: rallar.ws.serverPeerId, incarnation });
market.start();
app.get('/api/cca', (context) => context.json({ incarnation, serverId: rallar.ws.serverPeerId }));
installApiHttpMiddleware(app, {
    http: configuration.http,
    stateApi: configuration.stateApi,
    timing
});

await serveApiApplication({ app, rallar, configuration });
const tickTimer = setInterval(() => market.tick(), 1000 / 30);
const publishTimer = setInterval(() => {
    void market.publish().catch((error) => console.error('Market publication failed', error));
}, 100);
process.on('SIGTERM', () => {
    clearInterval(tickTimer);
    clearInterval(publishTimer);
    market.stop();
});
process.on('SIGINT', () => {
    clearInterval(tickTimer);
    clearInterval(publishTimer);
    market.stop();
});
console.log(
    `CCA server started on port ${configuration.http.port}. http://localhost:${configuration.http.port}/api/docs`
);
