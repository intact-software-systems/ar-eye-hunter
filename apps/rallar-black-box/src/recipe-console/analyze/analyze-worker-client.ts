import type {
    AnalyzeWorkerArtifactOffer,
    AnalyzeWorkerEnvelope,
    AnalyzeWorkerRequest,
    AnalyzeWorkerResponse,
} from './analyze-worker-contract.ts';
import { createAnalyzeExportBlobRetention } from './analyze-export-blob.ts';
import type { AnalyzeWorkerPort } from './analyze-worker-factory.ts';
import { createDistributedRunArtifactFilename } from
    '../control/distributed-run-artifact-download.ts';
import { isAnalyzeWorkerArtifactOffer } from './analyze-worker-request-boundary.ts';
import { createAnalyzeWorkerRpcClient } from './analyze-worker-client-rpc.ts';
import { recordAnalyzeWorkerClientTelemetry } from
    './analyze-worker-client-telemetry.ts';
import type {
    AnalyzeWorkerClient,
    AnalyzeWorkerClientOptions,
    AnalyzeWorkerTimerHandle,
} from './analyze-worker-client-contract.ts';

export type {
    AnalyzeWorkerClient,
    AnalyzeWorkerClientCallbacks,
} from './analyze-worker-client-contract.ts';

type CompleteResponse = Extract<AnalyzeWorkerResponse, { type: 'complete' }>;
type WorkerOwner = {
    worker: AnalyzeWorkerPort;
    operationGeneration: number;
    modelGeneration?: number;
    messageListener: EventListener;
    errorListener: EventListener;
    messageErrorListener: EventListener;
    watchdog?: AnalyzeWorkerTimerHandle;
};

export function createAnalyzeWorkerClient(
    input: AnalyzeWorkerClientOptions,
): AnalyzeWorkerClient {
    const callbacks = input.callbacks ?? {};
    const frame = input.requestAnimationFrame ??
        globalThis.requestAnimationFrame.bind(globalThis);
    const setTimer = input.setTimeout ?? globalThis.setTimeout.bind(globalThis);
    const clearTimer = input.clearTimeout ?? globalThis.clearTimeout.bind(globalThis);
    const watchdogMs = input.watchdogMs ?? 30_000;
    const exports = createAnalyzeExportBlobRetention();
    let candidate: WorkerOwner | undefined;
    let accepted: WorkerOwner | undefined;
    let operationGeneration = 0;
    let disposed = false;

    const rpc = createAnalyzeWorkerRpcClient({
        getAccepted: () => accepted?.modelGeneration === undefined
            ? undefined
            : { worker: accepted.worker, modelGeneration: accepted.modelGeneration },
        isDisposed: () => disposed,
        callbacks,
        setTimer,
        clearTimer,
        watchdogMs,
        performance: input.performance,
    });

    function offer(
        artifact: AnalyzeWorkerArtifactOffer,
        requestedGeneration?: number,
    ): number {
        if (disposed) throw new Error('The Analyze worker client is disposed.');
        if (!isAnalyzeWorkerArtifactOffer(artifact)) {
            throw new Error('Analyze worker offer metadata exceeds its bounded contract.');
        }
        if (candidate) terminateOwner(candidate, 'replacement');
        const generation = requestedGeneration ?? operationGeneration + 1;
        if (!Number.isSafeInteger(generation) || generation <= operationGeneration) {
            throw new Error('Analyze worker operation generations must increase monotonically.');
        }
        operationGeneration = generation;
        const owner = attachWorker(input.createWorker(), generation);
        candidate = owner;
        owner.watchdog = setTimer(() => {
            if (candidate !== owner) return;
            candidate = undefined;
            terminateOwner(owner, 'crash');
            exports.reject(generation);
            callbacks.onUnavailable?.('timeout', 'candidate');
        }, watchdogMs);
        try {
            post(owner.worker, {
                type: 'offer', operationGeneration: generation, artifact,
            }, [
                ...artifact.files.map(file => file.bytes),
                ...(artifact.controlEnvelope ? [artifact.controlEnvelope] : []),
            ]);
        } catch (error) {
            if (candidate === owner) candidate = undefined;
            exports.reject(generation);
            terminateOwner(owner, 'crash');
            throw error;
        }
        return generation;
    }

    function attachWorker(worker: AnalyzeWorkerPort, generation: number): WorkerOwner {
        const owner = {} as WorkerOwner;
        const messageListener: EventListener = event => {
            void handleMessage(owner, (event as MessageEvent<AnalyzeWorkerResponse>).data);
        };
        const errorListener: EventListener = () => unavailable(owner, 'error');
        const messageErrorListener: EventListener = () => unavailable(owner, 'messageerror');
        Object.assign(owner, {
            worker, operationGeneration: generation,
            messageListener, errorListener, messageErrorListener,
        });
        worker.addEventListener('message', messageListener);
        worker.addEventListener('error', errorListener);
        worker.addEventListener('messageerror', messageErrorListener);
        return owner;
    }

    async function handleMessage(
        owner: WorkerOwner,
        message: AnalyzeWorkerResponse,
    ): Promise<void> {
        if (disposed || (owner !== candidate && owner !== accepted)) return;
        if (message.type === 'accepted') {
            if (owner !== candidate ||
                message.operationGeneration !== owner.operationGeneration) return;
            callbacks.onAccepted?.(message.operationGeneration);
            frame(() => {
                if (candidate !== owner || disposed) return;
                callbacks.onPendingPaint?.(message.operationGeneration);
                frame(() => {
                    if (candidate !== owner || disposed) return;
                    post(owner.worker, {
                        type: 'start', operationGeneration: message.operationGeneration,
                    });
                });
            });
            return;
        }
        if (message.type === 'complete') {
            complete(owner, message);
            return;
        }
        if (message.type === 'failed') {
            if (owner === candidate) {
                callbacks.onFailure?.(message.error, message.operationGeneration);
                candidate = undefined;
                exports.reject(owner.operationGeneration);
                terminateOwner(owner, 'crash');
            } else {
                rpc.finishFailure(message);
            }
            return;
        }
        if (message.type === 'disposed') return;
        if (owner !== accepted || message.modelGeneration !== owner.modelGeneration) return;
        rpc.handleResponse(message);
    }

    function complete(owner: WorkerOwner, message: CompleteResponse): void {
        if (owner !== candidate ||
            message.operationGeneration !== owner.operationGeneration) return;
        if (input.validateComplete?.(message) === false) {
            clearOwnerWatchdog(owner);
            candidate = undefined;
            exports.reject(owner.operationGeneration);
            callbacks.onFailure?.({
                code: 'identity-mismatch', stage: 'model', recoverable: true,
            }, owner.operationGeneration);
            terminateOwner(owner, 'crash');
            return;
        }
        clearOwnerWatchdog(owner);
        exports.stage({
            generation: message.operationGeneration,
            blob: new Blob([message.exportBytes], { type: 'application/json' }),
            filename: createDistributedRunArtifactFilename(
                message.projection.distributedRunId,
            ),
        });
        const previous = accepted;
        accepted = owner;
        candidate = undefined;
        owner.modelGeneration = message.modelGeneration;
        exports.commit(message.operationGeneration);
        rpc.clear();
        callbacks.onComplete?.(message);
        if (previous && previous !== owner) terminateOwner(previous, 'replacement');
        recordAnalyzeWorkerClientTelemetry(input.performance, 'model', message);
    }

    function unavailable(
        owner: WorkerOwner,
        reason: 'error' | 'messageerror',
    ): void {
        if (owner !== candidate && owner !== accepted) return;
        const scope = owner === candidate ? 'candidate' : 'accepted-worker';
        if (owner === candidate) {
            candidate = undefined;
            exports.reject(owner.operationGeneration);
        } else {
            accepted = undefined;
            rpc.clear();
        }
        terminateOwner(owner, 'crash');
        callbacks.onUnavailable?.(reason, scope);
    }

    function terminateOwner(
        owner: WorkerOwner,
        reason: Extract<AnalyzeWorkerRequest, { type: 'dispose' }>['reason'],
    ): void {
        clearOwnerWatchdog(owner);
        owner.worker.removeEventListener('message', owner.messageListener);
        owner.worker.removeEventListener('error', owner.errorListener);
        owner.worker.removeEventListener('messageerror', owner.messageErrorListener);
        try { post(owner.worker, { type: 'dispose', reason }); } catch { /* terminated */ }
        owner.worker.terminate();
    }

    function clearOwnerWatchdog(owner: WorkerOwner): void {
        if (owner.watchdog !== undefined) clearTimer(owner.watchdog);
        owner.watchdog = undefined;
    }

    function clear(): void {
        if (candidate) terminateOwner(candidate, 'clear');
        if (accepted) terminateOwner(accepted, 'clear');
        candidate = undefined;
        accepted = undefined;
        rpc.clear();
        exports.clear();
    }

    function cancelCandidate(reason: 'replacement' | 'crash' = 'replacement'): void {
        if (!candidate) return;
        const owner = candidate;
        candidate = undefined;
        exports.reject(owner.operationGeneration);
        terminateOwner(owner, reason);
    }

    function dispose(): void {
        if (disposed) return;
        clear();
        disposed = true;
    }

    return {
        offer,
        search: rpc.search,
        window: rpc.window,
        select: rpc.select,
        tune: rpc.tune,
        currentExport: exports.current,
        cancelCandidate,
        clear,
        dispose,
    };
}

function post(
    worker: AnalyzeWorkerPort,
    message: AnalyzeWorkerRequest,
    transfer: readonly Transferable[] = [],
): void {
    worker.postMessage(message, transfer as Transferable[]);
}
