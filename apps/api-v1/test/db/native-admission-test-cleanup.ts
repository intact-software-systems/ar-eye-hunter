import type { ApiV1Runtime } from '../../src/composition/api-v1-runtime.ts';

export interface NativeAdmissionTestCleanup {
    readonly socketClosures: readonly Promise<void>[];
    readonly waitForSessionDisconnects: () => Promise<void>;
    readonly webSocketLifecycle: Pick<ApiV1Runtime['wsQBoxServerService'], 'dispose'>;
    readonly listener: Pick<Deno.HttpServer<Deno.NetAddr>, 'shutdown'> | undefined;
    readonly backgroundTasks: Pick<ApiV1Runtime['backgroundTasks'], 'stop'>;
    readonly engine: Pick<ApiV1Runtime['qboxEngine'], 'stop' | 'executeOnce'>;
    readonly backgroundProducersStopped: Promise<void>;
    readonly queueEngineStopped: PromiseWithResolvers<void>;
    readonly primaryFailure: Error | undefined;
    readonly reportProgress: (message: string) => void;
    readonly reportSecondaryFailures: (failure: AggregateError) => void;
}

export async function stopNativeAdmissionTestRuntime(cleanup: NativeAdmissionTestCleanup): Promise<void> {
    const failures: Error[] = [];
    const socketClosures = await Promise.allSettled(cleanup.socketClosures);
    for (const [index, closure] of socketClosures.entries()) {
        if (closure.status === 'rejected') {
            failures.push(toNativeAdmissionCleanupFailure(`socket ${index}`, closure.reason));
        }
    }
    if (socketClosures.every((closure) => closure.status === 'fulfilled')) {
        writeNativeAdmissionCleanupProgress(cleanup, failures, 'Native admission cleanup: sockets closed');
    }

    try {
        await cleanup.waitForSessionDisconnects();
        writeNativeAdmissionCleanupProgress(
            cleanup,
            failures,
            'Native admission cleanup: authoritative disconnects completed'
        );
    }
    catch (error) {
        failures.push(toNativeAdmissionCleanupFailure('authoritative disconnects', error));
    }

    try {
        await cleanup.webSocketLifecycle.dispose();
        writeNativeAdmissionCleanupProgress(
            cleanup,
            failures,
            'Native admission cleanup: ALM work and retained releases stopped'
        );
    }
    catch (error) {
        failures.push(toNativeAdmissionCleanupFailure('websocket lifecycle', error));
    }

    try {
        await cleanup.listener?.shutdown();
        writeNativeAdmissionCleanupProgress(cleanup, failures, 'Native admission cleanup: listener stopped');
    }
    catch (error) {
        failures.push(toNativeAdmissionCleanupFailure('listener', error));
    }

    let backgroundFailure: Error | undefined;
    let stoppingBackground: Promise<void>;
    try {
        stoppingBackground = cleanup.backgroundTasks.stop().catch((error) => {
            backgroundFailure = toNativeAdmissionCleanupFailure('background tasks and database', error);
        });
    }
    catch (error) {
        backgroundFailure = toNativeAdmissionCleanupFailure('background tasks and database', error);
        stoppingBackground = Promise.resolve();
    }
    try {
        await Promise.race([cleanup.backgroundProducersStopped, stoppingBackground]);
    }
    catch (error) {
        failures.push(toNativeAdmissionCleanupFailure('background producer barrier', error));
    }

    try {
        cleanup.engine.stop();
        writeNativeAdmissionCleanupProgress(
            cleanup,
            failures,
            'Native admission cleanup: workers stopped after background producers'
        );
    }
    catch (error) {
        failures.push(toNativeAdmissionCleanupFailure('engine stop', error));
    }
    try {
        await cleanup.engine.executeOnce();
        writeNativeAdmissionCleanupProgress(cleanup, failures, 'Native admission cleanup: engine pass finished');
    }
    catch (error) {
        failures.push(toNativeAdmissionCleanupFailure('final engine pass', error));
    }
    finally {
        cleanup.queueEngineStopped.resolve();
        await stoppingBackground;
    }
    if (backgroundFailure) {
        failures.push(backgroundFailure);
    }
    else {
        writeNativeAdmissionCleanupProgress(
            cleanup,
            failures,
            'Native admission cleanup: background tasks and database stopped'
        );
    }

    if (cleanup.primaryFailure) {
        try {
            if (failures.length > 0) {
                cleanup.reportSecondaryFailures(
                    new AggregateError(failures, 'Native admission secondary cleanup failures')
                );
            }
        }
        catch (error) {
            failures.push(toNativeAdmissionCleanupFailure('secondary failure reporting', error));
        }
        throw cleanup.primaryFailure;
    }
    if (failures.length === 1) {
        throw failures[0];
    }
    if (failures.length > 1) {
        throw new AggregateError(failures, 'Native admission cleanup failed');
    }
}

function toNativeAdmissionCleanupFailure(stage: string, error: unknown): Error {
    const cause = error instanceof Error ? error : new Error(String(error));
    return new Error(`Native admission cleanup failed: ${stage}`, { cause });
}

function writeNativeAdmissionCleanupProgress(
    cleanup: NativeAdmissionTestCleanup,
    failures: Error[],
    message: string
): void {
    try {
        cleanup.reportProgress(message);
    }
    catch (error) {
        failures.push(toNativeAdmissionCleanupFailure('progress reporting', error));
    }
}
