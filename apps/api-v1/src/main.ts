import { Hono } from 'hono';
import { readFile } from 'node:fs/promises';

import { createDefaultRallarServer } from './composition/create-default-rallar-server.ts';
import { readApiV1Configuration } from './configuration/read-api-v1-configuration.ts';
import { reportApiV1Configuration } from './configuration/report-api-v1-configuration.ts';
import { createDefaultApiV1DatabaseLifecycle } from './db/api-v1-database-lifecycle.ts';
import { myServerId } from './runtime/runtime-identity.ts';
import { serveApiApplication } from './runtime/serve-api-application.ts';
import { installApiHttpMiddleware } from './services/install-api-http-middleware.ts';
import { createApiTimingSink } from './services/timing-service.ts';

const configuration = await readApiV1Configuration({
    environment: process.env,
    hardwareConcurrency: navigator.hardwareConcurrency,
    readTextFile: (url) => readFile(url, 'utf8'),
    defaultsUrl: new URL('../resources/configuration/defaults-config.json', import.meta.url),
    profileUrls: {
        dev: new URL('../resources/configuration/dev-config.json', import.meta.url),
        prod: new URL('../resources/configuration/prod-config.json', import.meta.url),
        'prod-hardened': new URL('../resources/configuration/prod-hardened-config.json', import.meta.url),
        'prod-in-memory': new URL('../resources/configuration/prod-in-memory-config.json', import.meta.url)
    },
    staticClientsUrl: new URL('../resources/authorised-clients.json', import.meta.url)
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
installApiHttpMiddleware(app, {
    http: configuration.http,
    stateApi: configuration.stateApi,
    timing
});

await serveApiApplication({ app, rallar, configuration });
console.log(`Server started on port ${configuration.http.port}. http://localhost:${configuration.http.port}/api/docs`);
