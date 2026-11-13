import { initServerProcessShutdown } from '@shared-server/process/init-server-process-shutdown.ts';
import type { RallarServerApplication } from '@shared-server/rallar-server/rallar-server-application.ts';
import { createDefaultBackgroundTimers } from '@shared/resilience/timers.ts';
import type { Hono } from 'hono';
import { websocket, type BunWebSocketData } from 'hono/bun';
import type { ApiV1Runtime } from '../composition/api-v1-runtime.ts';
import type { ApiV1Configuration } from '../configuration/api-v1-configuration.ts';
import { computeApiShutdownGraceMs } from '../configuration/compute-api-shutdown-grace-ms.ts';
import { startApiProcess } from './api-process-startup.ts';
import { stopApiOnRtcTopologyDeliveryHealthFailure } from './rtc-topology/rtc-topology-delivery-health-shutdown.ts';
import { stopApiHttpServer } from './stop-api-http-server.ts';
import { toApiBunServeOptions } from './to-api-bun-serve-options.ts';

export interface ServeApiApplicationInput {
    readonly app: Hono;
    readonly rallar: RallarServerApplication<ApiV1Runtime, Hono>;
    readonly configuration: ApiV1Configuration;
}

/** Embedded applications install their own routes and workers first, then share the API's startup/failure lifecycle. */
export async function serveApiApplication(
    input: ServeApiApplicationInput
): Promise<Bun.Server<BunWebSocketData>> {
    const { rallar, app, configuration } = input;
    rallar.installSystemTopics();
    rallar.installWebSocketLifecycle();
    rallar.mountWebSocket(app);
    rallar.mountRest(app);
    const startup = await startApiProcess({
        runtimeReadiness: rallar.runtime.readiness,
        listen: () => Bun.serve(toApiBunServeOptions(configuration, { fetch: app.fetch, websocket })),
        startApplication: () => rallar.start({ queueWorkers: configuration.topology.replay.queueWorkers }),
        stopAfterStartupFailure: (server) => cleanupApiStartup(input, server)
    });
    installHealthShutdown(input, startup.httpServer);
    initServerProcessShutdown({
        process,
        signals: ['SIGTERM', 'SIGINT'],
        stop: () => stopApiApplication(input, startup.httpServer),
        log: console,
        timers: createDefaultBackgroundTimers(),
        deadlineMs: input.configuration.http.shutdownDeadlineMs
    });
    return startup.httpServer;
}

/**
 * The drain keeps the queue workers running, so an HTTP mutation awaiting its AppInbox completion can finish within
 * the grace; workers and background tasks (which close the database) stop only after it.
 */
async function stopApiApplication(
    input: ServeApiApplicationInput,
    server: Bun.Server<BunWebSocketData>
): Promise<void> {
    await runApiStopSteps([
        async () => {
            await stopApiHttpServer(server, {
                graceMs: computeApiShutdownGraceMs(input.configuration.http),
                timers: createDefaultBackgroundTimers(),
                closeWebSockets: () =>
                    input.rallar.runtime.wsQBoxServerService.socket.stopAcceptingConnections(
                        1001,
                        'server-shutting-down'
                    ),
                log: console
            });
        },
        () => input.rallar.runtime.qboxEngine.stop(),
        () => input.rallar.runtime.backgroundTasks.stop()
    ], 'API shutdown failed');
}

async function cleanupApiStartup(
    input: ServeApiApplicationInput,
    server: Bun.Server<BunWebSocketData> | undefined
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

function installHealthShutdown(
    input: ServeApiApplicationInput,
    httpServer: Bun.Server<BunWebSocketData>
): void {
    const { rallar } = input;
    if (!rallar.runtime.healthFailure) {
        return;
    }
    void stopApiOnRtcTopologyDeliveryHealthFailure({
        healthFailure: rallar.runtime.healthFailure,
        onHealthFailure: (error) => console.error('RTC topology delivery health failed; stopping API process:', error),
        stopQueueWorkers: () => rallar.runtime.qboxEngine.stop(),
        closeWebSockets: () =>
            rallar.runtime.wsQBoxServerService.socket.stopAcceptingConnections(
                1012,
                'rtc-topology-delivery-lease-lost'
            ),
        stopBackgroundTasks: () => rallar.runtime.backgroundTasks.stop(),
        shutdownHttp: async () => await httpServer.stop(),
        onShutdownStepFailure: (step, error) =>
            console.error(`RTC topology delivery shutdown step ${step} failed:`, error)
    });
}
