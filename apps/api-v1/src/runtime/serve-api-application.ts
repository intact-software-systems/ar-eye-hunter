import type { RallarServerApplication } from '@shared-server/rallar-server/rallar-server-application.ts';
import type { Hono } from 'jsr:@hono/hono@4.11.9';
import type { ApiV1Runtime } from '../composition/api-v1-runtime.ts';
import type { ApiV1Configuration } from '../configuration/api-v1-configuration.ts';
import { startApiProcess } from './api-process-startup.ts';
import { stopApiOnRtcTopologyDeliveryHealthFailure } from './rtc-topology/rtc-topology-delivery-health-shutdown.ts';

export interface ServeApiApplicationInput {
    readonly app: Hono;
    readonly rallar: RallarServerApplication<ApiV1Runtime, Hono>;
    readonly configuration: ApiV1Configuration;
}

/** Embedded applications install their own routes and workers first, then share the API's startup/failure lifecycle. */
export async function serveApiApplication(input: ServeApiApplicationInput): Promise<Deno.HttpServer> {
    const { rallar, app, configuration } = input;
    addEventListener('unload', () => {
        void rallar.runtime.backgroundTasks.stop().catch((error) =>
            console.error('Failed to stop middleware background tasks:', error)
        );
    });
    rallar.installSystemTopics();
    rallar.installWebSocketLifecycle();
    rallar.mountWebSocket(app);
    rallar.mountRest(app);
    const process = await startApiProcess({
        runtimeReadiness: rallar.runtime.readiness,
        listen: () => Deno.serve({ port: configuration.http.port }, app.fetch),
        startApplication: () => rallar.start({ queueWorkers: configuration.topology.replay.queueWorkers }),
        stopAfterStartupFailure: (server) => cleanupApiStartup(input, server)
    });
    installHealthShutdown(input, process.httpServer);
    return process.httpServer;
}

async function cleanupApiStartup(input: ServeApiApplicationInput, server: Deno.HttpServer | undefined): Promise<void> {
    const failures: Error[] = [];
    const steps = [
        () => input.rallar.runtime.qboxEngine.stop(),
        async () => {
            if (server !== undefined) {
                await server.shutdown();
            }
        },
        () => input.rallar.runtime.backgroundTasks.stop()
    ];
    for (const stop of steps) {
        try {
            await stop();
        }
        catch (error) {
            failures.push(
                error instanceof Error ? error : new Error('API cleanup threw a non-Error value', { cause: error })
            );
        }
    }
    if (failures.length > 0) {
        throw new AggregateError(failures, 'API startup cleanup failed');
    }
}

function installHealthShutdown({ rallar }: ServeApiApplicationInput, httpServer: Deno.HttpServer): void {
    if (!rallar.runtime.healthFailure) {
        return;
    }
    void stopApiOnRtcTopologyDeliveryHealthFailure({
        healthFailure: rallar.runtime.healthFailure,
        onHealthFailure: (error) => console.error('RTC topology delivery health failed; stopping API process:', error),
        stopQueueWorkers: () => rallar.runtime.qboxEngine.stop(),
        closeWebSockets: () => {
            const socket = rallar.runtime.wsQBoxServerService.socket;
            for (const connectionId of socket.connections.keys()) {
                socket.closeConnection(connectionId, 1012, 'rtc-topology-delivery-lease-lost');
            }
        },
        stopBackgroundTasks: () => rallar.runtime.backgroundTasks.stop(),
        shutdownHttp: async () => await httpServer.shutdown(),
        onShutdownStepFailure: (step, error) =>
            console.error(`RTC topology delivery shutdown step ${step} failed:`, error)
    });
}
