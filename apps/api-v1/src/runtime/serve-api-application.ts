import { initServerProcessShutdown } from '@shared-server/process/init-server-process-shutdown.ts';
import type { RallarServerApplication } from '@shared-server/rallar-server/rallar-server-application.ts';
import type { Hono } from 'hono';
import type { ApiV1Runtime } from '../composition/api-v1-runtime.ts';
import { createApiWebSocketRouteDependencies } from '../composition/create-api-v1-route-installers.ts';
import type { ApiV1Configuration } from '../configuration/api-v1-configuration.ts';
import { createApiWebSocketServeHandlers, type ApiWebSocketConnectionData } from '../routes/ws-routes.ts';
import { startApiProcess } from './api-process-startup.ts';
import { stopApiOnRtcTopologyDeliveryHealthFailure } from './rtc-topology/rtc-topology-delivery-health-shutdown.ts';

export interface ServeApiApplicationInput {
    readonly app: Hono;
    readonly rallar: RallarServerApplication<ApiV1Runtime, Hono>;
    readonly configuration: ApiV1Configuration;
}

/** Embedded applications install their own routes and workers first, then share the API's startup/failure lifecycle. */
export async function serveApiApplication(
    input: ServeApiApplicationInput
): Promise<Bun.Server<ApiWebSocketConnectionData>> {
    const { rallar, app, configuration } = input;
    rallar.installSystemTopics();
    rallar.installWebSocketLifecycle();
    rallar.mountRest(app);
    const wsDependencies = createApiWebSocketRouteDependencies(rallar.runtime, Date.now);
    const wsHandlers = createApiWebSocketServeHandlers(wsDependencies, app);
    const startup = await startApiProcess({
        runtimeReadiness: rallar.runtime.readiness,
        listen: () =>
            Bun.serve({
                port: configuration.http.port,
                fetch: wsHandlers.fetch,
                websocket: wsHandlers.websocket
            }),
        startApplication: () => rallar.start({ queueWorkers: configuration.topology.replay.queueWorkers }),
        stopAfterStartupFailure: (server) => cleanupApiStartup(input, server)
    });
    installHealthShutdown(input, startup.httpServer);
    initServerProcessShutdown({
        process,
        signals: ['SIGTERM', 'SIGINT'],
        stop: () => stopApiApplication(input, startup.httpServer),
        log: console
    });
    return startup.httpServer;
}

/**
 * A graceful `server.stop()` refuses new connections but lets in-flight requests finish, so an HTTP mutation
 * awaiting its AppInbox completion keeps the queue workers it waits on; open WebSockets would hold the drain
 * open, so they close first. Workers and background tasks (which close the database) stop only after the drain.
 */
async function stopApiApplication(
    input: ServeApiApplicationInput,
    server: Bun.Server<ApiWebSocketConnectionData>
): Promise<void> {
    await runApiStopSteps([
        async () => {
            const drained = server.stop();
            closeApiWebSockets(input, 1001, 'server-shutting-down');
            await drained;
        },
        () => input.rallar.runtime.qboxEngine.stop(),
        () => input.rallar.runtime.backgroundTasks.stop()
    ], 'API shutdown failed');
}

async function cleanupApiStartup(
    input: ServeApiApplicationInput,
    server: Bun.Server<ApiWebSocketConnectionData> | undefined
): Promise<void> {
    await runApiStopSteps([
        () => input.rallar.runtime.qboxEngine.stop(),
        async () => await server?.stop(),
        () => input.rallar.runtime.backgroundTasks.stop()
    ], 'API startup cleanup failed');
}

async function runApiStopSteps(steps: readonly (() => void | Promise<void>)[], message: string): Promise<void> {
    const failures: Error[] = [];
    for (const stop of steps) {
        try {
            await stop();
        }
        catch (error) {
            failures.push(
                error instanceof Error ? error : new Error('API stop step threw a non-Error value', { cause: error })
            );
        }
    }
    if (failures.length > 0) {
        throw new AggregateError(failures, message);
    }
}

function closeApiWebSockets({ rallar }: ServeApiApplicationInput, code: number, reason: string): void {
    const socket = rallar.runtime.wsQBoxServerService.socket;
    for (const connectionId of socket.connections.keys()) {
        socket.closeConnection(connectionId, code, reason);
    }
}

function installHealthShutdown(
    input: ServeApiApplicationInput,
    httpServer: Bun.Server<ApiWebSocketConnectionData>
): void {
    const { rallar } = input;
    if (!rallar.runtime.healthFailure) {
        return;
    }
    void stopApiOnRtcTopologyDeliveryHealthFailure({
        healthFailure: rallar.runtime.healthFailure,
        onHealthFailure: (error) => console.error('RTC topology delivery health failed; stopping API process:', error),
        stopQueueWorkers: () => rallar.runtime.qboxEngine.stop(),
        closeWebSockets: () => closeApiWebSockets(input, 1012, 'rtc-topology-delivery-lease-lost'),
        stopBackgroundTasks: () => rallar.runtime.backgroundTasks.stop(),
        shutdownHttp: async () => await httpServer.stop(),
        onShutdownStepFailure: (step, error) =>
            console.error(`RTC topology delivery shutdown step ${step} failed:`, error)
    });
}
