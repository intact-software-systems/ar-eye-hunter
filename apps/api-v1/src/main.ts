import 'jsr:@std/dotenv@0.225.6/load';
import { Hono } from 'jsr:@hono/hono@4.11.9';

import { createDefaultRallarServer } from './composition/create-default-rallar-server.ts';
import {
    readApiV1Configuration,
    toApiV1ConfigurationStartupSummary
} from './configuration/read-api-v1-configuration.ts';
import { createDefaultApiV1DatabaseLifecycle } from './db/api-v1-database-lifecycle.ts';
import { startApiProcess } from './runtime/api-process-startup.ts';
import {
    stopApiOnRtcTopologyDeliveryHealthFailure
} from './runtime/rtc-topology/rtc-topology-delivery-health-shutdown.ts';
import { myServerId } from './runtime/runtime-identity.ts';
import { installApiHttpMiddleware } from './services/install-api-http-middleware.ts';
import { createApiTimingSink } from './services/timing-service.ts';

const configuration = await readApiV1Configuration({
    environment: Deno.env,
    hardwareConcurrency: navigator.hardwareConcurrency,
    readTextFile: Deno.readTextFile,
    defaultsUrl: new URL('../resources/configuration/defaults-config.json', import.meta.url),
    profileUrls: {
        dev: new URL('../resources/configuration/dev-config.json', import.meta.url),
        prod: new URL('../resources/configuration/prod-config.json', import.meta.url),
        'prod-hardened': new URL('../resources/configuration/prod-hardened-config.json', import.meta.url),
        'prod-in-memory': new URL('../resources/configuration/prod-in-memory-config.json', import.meta.url)
    },
    staticClientsUrl: new URL('../resources/authorised-clients.json', import.meta.url)
});
console.log(JSON.stringify({
    event: 'api-v1.configuration',
    ...toApiV1ConfigurationStartupSummary(configuration)
}));
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
addEventListener('unload', () => {
    void rallar.runtime.backgroundTasks.stop().catch((error) => {
        console.error('Failed to stop middleware background tasks:', error);
    });
});

const app: Hono = new Hono();
installApiHttpMiddleware(app, {
    http: configuration.http,
    stateApi: configuration.stateApi,
    timing
});

rallar.installSystemTopics();
rallar.installWebSocketLifecycle();
rallar.mountWebSocket(app);
rallar.mountRest(app);

const port = configuration.http.port;
const apiProcess = await startApiProcess({
    runtimeReadiness: rallar.runtime.readiness,
    listen: () => Deno.serve({ port }, app.fetch),
    startQueueWorkers: () => {
        if (configuration.topology.replay.queueWorkers === 'enabled') {
            rallar.start();
        }
    },
    stopAfterStartupFailure: async (boundHttpServer) => {
        const failures: Error[] = [];
        try {
            await rallar.runtime.qboxEngine.stop();
        }
        catch (error) {
            failures.push(
                error instanceof Error
                    ? error
                    : new Error('Queue worker cleanup threw a non-Error value.', { cause: error })
            );
        }
        if (boundHttpServer !== undefined) {
            try {
                await boundHttpServer.shutdown();
            }
            catch (error) {
                failures.push(
                    error instanceof Error
                        ? error
                        : new Error('HTTP server cleanup threw a non-Error value.', { cause: error })
                );
            }
        }
        try {
            await rallar.runtime.backgroundTasks.stop();
        }
        catch (error) {
            failures.push(
                error instanceof Error
                    ? error
                    : new Error('Background task cleanup threw a non-Error value.', { cause: error })
            );
        }
        if (failures.length > 0) {
            throw new AggregateError(failures, 'API-v1 startup cleanup failed');
        }
    }
});
const httpServer = apiProcess.httpServer;
if (rallar.runtime.healthFailure) {
    void stopApiOnRtcTopologyDeliveryHealthFailure({
        healthFailure: rallar.runtime.healthFailure,
        onHealthFailure: (error) => {
            console.error('RTC topology delivery health failed; stopping API process:', error);
        },
        stopQueueWorkers: () => rallar.runtime.qboxEngine.stop(),
        closeWebSockets: () => {
            const socketServer = rallar.runtime.wsQBoxServerService.socket;
            for (const connectionId of socketServer.connections.keys()) {
                socketServer.closeConnection(
                    connectionId,
                    1012,
                    'rtc-topology-delivery-lease-lost'
                );
            }
        },
        stopBackgroundTasks: () => rallar.runtime.backgroundTasks.stop(),
        shutdownHttp: async () => await httpServer.shutdown(),
        onShutdownStepFailure: (step, error) => {
            console.error(`RTC topology delivery shutdown step ${step} failed:`, error);
        }
    });
}
console.log(`Server started on port ${port}. http://localhost:${port}/api/docs`);
