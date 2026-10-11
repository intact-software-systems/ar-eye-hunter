import type { ApiV1Runtime } from '../../src/composition/api-v1-runtime.ts';
import type { ApiV1DatabaseLifecycle } from '../../src/db/api-v1-database-lifecycle.ts';

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
    await stopNativeAdmissionConnections(cleanup, failures);
    await stopNativeAdmissionBackgroundAndQueues(cleanup, failures);
    finishNativeAdmissionCleanup(cleanup, failures);
}

async function stopNativeAdmissionConnections(cleanup: NativeAdmissionTestCleanup, failures: Error[]): Promise<void> {
    const socketClosures = await Promise.allSettled(cleanup.socketClosures);
    for (const [index, closure] of socketClosures.entries()) {
        if (closure.status === 'rejected') {
            failures.push(toNativeAdmissionCleanupFailure(`socket ${index}`, closure.reason));
        }
    }
    if (socketClosures.every((closure) => closure.status === 'fulfilled')) {
        writeNativeAdmissionCleanupProgress(
            cleanup.reportProgress,
            failures,
            'Native admission cleanup: sockets closed'
        );
    }

    try {
        await cleanup.waitForSessionDisconnects();
        writeNativeAdmissionCleanupProgress(
            cleanup.reportProgress,
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
            cleanup.reportProgress,
            failures,
            'Native admission cleanup: ALM work and retained releases stopped'
        );
    }
    catch (error) {
        failures.push(toNativeAdmissionCleanupFailure('websocket lifecycle', error));
    }

    try {
        await cleanup.listener?.shutdown();
        writeNativeAdmissionCleanupProgress(
            cleanup.reportProgress,
            failures,
            'Native admission cleanup: listener stopped'
        );
    }
    catch (error) {
        failures.push(toNativeAdmissionCleanupFailure('listener', error));
    }
}

async function stopNativeAdmissionBackgroundAndQueues(
    cleanup: NativeAdmissionTestCleanup,
    failures: Error[]
): Promise<void> {
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

    await finishNativeAdmissionQueueEngine(cleanup, failures, stoppingBackground);
    if (backgroundFailure) {
        failures.push(backgroundFailure);
    }
    else {
        writeNativeAdmissionCleanupProgress(
            cleanup.reportProgress,
            failures,
            'Native admission cleanup: background tasks and database stopped'
        );
    }
}

async function finishNativeAdmissionQueueEngine(
    cleanup: NativeAdmissionTestCleanup,
    failures: Error[],
    stoppingBackground: Promise<void>
): Promise<void> {
    try {
        cleanup.engine.stop();
        writeNativeAdmissionCleanupProgress(
            cleanup.reportProgress,
            failures,
            'Native admission cleanup: workers stopped after background producers'
        );
    }
    catch (error) {
        failures.push(toNativeAdmissionCleanupFailure('engine stop', error));
    }
    try {
        await cleanup.engine.executeOnce();
        writeNativeAdmissionCleanupProgress(
            cleanup.reportProgress,
            failures,
            'Native admission cleanup: engine pass finished'
        );
    }
    catch (error) {
        failures.push(toNativeAdmissionCleanupFailure('final engine pass', error));
    }
    finally {
        cleanup.queueEngineStopped.resolve();
        await stoppingBackground;
    }
}

function finishNativeAdmissionCleanup(cleanup: NativeAdmissionTestCleanup, failures: Error[]): void {
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
    reportProgress: NativeAdmissionTestCleanup['reportProgress'],
    failures: Error[],
    message: string
): void {
    try {
        reportProgress(message);
    }
    catch (error) {
        failures.push(toNativeAdmissionCleanupFailure('progress reporting', error));
    }
}

export async function closeNativeAdmissionTestDatabase(
    databaseLifecycle: Pick<ApiV1DatabaseLifecycle, 'close'>,
    reportProgress: NativeAdmissionTestCleanup['reportProgress']
): Promise<void> {
    const failures: Error[] = [];
    writeNativeAdmissionCleanupProgress(reportProgress, failures, 'Native admission cleanup: database close started');
    try {
        await databaseLifecycle.close();
        writeNativeAdmissionCleanupProgress(
            reportProgress,
            failures,
            'Native admission cleanup: database close finished'
        );
    }
    catch (error) {
        failures.push(toNativeAdmissionCleanupFailure('database close', error));
    }
    if (failures.length > 0) {
        throw new AggregateError(failures, 'Native admission database cleanup failed');
    }
}
