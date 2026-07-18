import {
    deriveDistributedArtifactEvidenceCollections,
    searchDistributedArtifactEvidenceWindow,
} from '@shared-test/rallar-bb-test/mod.ts';
import {
    finalizeAnalyzeArtifactModel,
    prepareAnalyzeArtifactModel,
} from './analyze-artifact-model.ts';
import {
    projectAnalyzeArtifactModel,
    projectAnalyzeEvidenceEntry,
    projectAnalyzeEvidenceWindow,
} from './analyze-artifact-projection.ts';
import {
    ANALYZE_WORKER_EVIDENCE_WINDOW_SIZE,
    type AnalyzeWorkerArtifactOffer,
    type AnalyzeWorkerEnvelope,
    type AnalyzeWorkerErrorProjection,
    type AnalyzeWorkerRequest,
    type AnalyzeWorkerResponse,
} from './analyze-worker-contract.ts';
import { decodeAnalyzeWorkerArtifactOffer } from
    './analyze-worker-offer-decoder.ts';
import {
    analyzeWorkerRequestIdentity,
    analyzeWorkerRequestStage,
    invalidAnalyzeWorkerRequestStage,
    isAnalyzeWorkerRequest,
} from './analyze-worker-request-boundary.ts';
import { analyzeControlIdentityMatchesDigest } from
    './analyze-control-identity-digest.ts';
import { createAnalyzeWorkerRpcRuntime } from './analyze-worker-rpc-runtime.ts';
import {
    AnalyzeControlEnvelopeIdentityError,
    analyzeWorkerDuration,
    analyzeWorkerModelError,
    analyzeWorkerTelemetry,
    type AnalyzeWorkerActiveModel,
} from './analyze-worker-runtime-model.ts';

export type AnalyzeWorkerRuntimeHost = Readonly<{
    postMessage(message: AnalyzeWorkerResponse, transfer?: readonly Transferable[]): void;
    close?(): void;
}>;

export type AnalyzeWorkerRuntime = Readonly<{
    handle(request: AnalyzeWorkerRequest): Promise<void>;
    dispose(): void;
}>;

export function createAnalyzeWorkerRuntime(
    host: AnalyzeWorkerRuntimeHost,
    options: Readonly<{ now?: () => number }> = {},
): AnalyzeWorkerRuntime {
    const now = options.now ?? performance.now.bind(performance);
    let offered: Readonly<{
        generation: number;
        artifact: AnalyzeWorkerArtifactOffer;
    }> | undefined;
    let active: AnalyzeWorkerActiveModel | undefined;
    let disposed = false;
    let highestOperationGeneration = -1;
    let startedOperationGeneration = -1;

    const post = (envelope: AnalyzeWorkerEnvelope): void => {
        host.postMessage(envelope.message, envelope.transfer);
    };

    const fail = (
        error: AnalyzeWorkerErrorProjection,
        request?: Readonly<{ operationGeneration?: number; requestId?: number }>,
    ): void => post({
        message: {
            type: 'failed',
            ...(request?.operationGeneration !== undefined
                ? { operationGeneration: request.operationGeneration }
                : {}),
            ...(request?.requestId !== undefined
                ? { requestId: request.requestId }
                : {}),
            error,
        },
    });

    const rpc = createAnalyzeWorkerRpcRuntime({
        getActive: () => active,
        isDisposed: () => disposed,
        now,
        post,
        fail,
    });

    const dispose = (): void => {
        offered = undefined;
        active = undefined;
        rpc.reset();
        disposed = true;
    };

    async function handle(request: AnalyzeWorkerRequest): Promise<void> {
        if (!isAnalyzeWorkerRequest(request)) {
            fail({
                code: 'invalid-request',
                stage: invalidAnalyzeWorkerRequestStage(request),
                recoverable: true,
            });
            return;
        }
        if (request.type === 'dispose') {
            dispose();
            post({ message: { type: 'disposed' } });
            host.close?.();
            return;
        }
        if (disposed) {
            fail({
                code: 'worker-disposed',
                stage: analyzeWorkerRequestStage(request),
                recoverable: false,
            }, analyzeWorkerRequestIdentity(request));
            return;
        }
        if (request.type === 'offer') {
            if (
                !Number.isSafeInteger(request.operationGeneration) ||
                request.operationGeneration < 0 ||
                request.operationGeneration <= highestOperationGeneration
            ) {
                fail({
                    code: 'stale-generation', stage: 'offer', recoverable: true,
                }, { operationGeneration: request.operationGeneration });
                return;
            }
            highestOperationGeneration = request.operationGeneration;
            startedOperationGeneration = -1;
            offered = {
                generation: request.operationGeneration,
                artifact: request.artifact,
            };
            active = undefined;
            rpc.reset();
            post({ message: {
                type: 'accepted',
                operationGeneration: request.operationGeneration,
            } });
            return;
        }
        if (request.type === 'start') {
            await start(request.operationGeneration);
            return;
        }
        if (!active || request.modelGeneration !== active.generation) {
            fail({
                code: 'stale-generation',
                stage: analyzeWorkerRequestStage(request),
                recoverable: true,
            }, analyzeWorkerRequestIdentity(request));
            return;
        }
        await rpc.handle(request);
    }

    async function start(operationGeneration: number): Promise<void> {
        const candidate = offered;
        if (!candidate || candidate.generation !== operationGeneration) {
            fail({
                code: 'stale-generation', stage: 'model', recoverable: true,
            }, { operationGeneration });
            return;
        }
        if (operationGeneration <= startedOperationGeneration) {
            fail({
                code: 'stale-generation', stage: 'model', recoverable: true,
            }, { operationGeneration });
            return;
        }
        startedOperationGeneration = operationGeneration;
        const startedAt = now();
        try {
            const parseStartedAt = now();
            const decoded = decodeAnalyzeWorkerArtifactOffer(candidate.artifact);
            const prepared = prepareAnalyzeArtifactModel({
                files: decoded.files,
                source: candidate.artifact.source,
                label: candidate.artifact.label,
                generatedAtEpochMs: decoded.generatedAtEpochMs,
                artifactSchemaVersion: decoded.artifactSchemaVersion,
                ignoredFiles: candidate.artifact.ignoredFiles,
            });
            const parseDurationMs = analyzeWorkerDuration(now(), parseStartedAt);
            const collections = await deriveDistributedArtifactEvidenceCollections(
                prepared.evidenceInput,
            );
            const model = finalizeAnalyzeArtifactModel(
                prepared,
                collections.index,
                collections.catalog.entries,
            );
            if (
                decoded.declaredDistributedRunId !== undefined &&
                decoded.declaredDistributedRunId !== model.distributedRunId
            ) {
                throw new AnalyzeControlEnvelopeIdentityError();
            }
            let controlIdentityValidated: true | undefined;
            if (candidate.artifact.source === 'control') {
                const expected = candidate.artifact.expectedControlIdentity;
                if (!expected || !await analyzeControlIdentityMatchesDigest(
                    model.identity,
                    expected,
                )) {
                    throw new AnalyzeControlEnvelopeIdentityError();
                }
                controlIdentityValidated = true;
            }
            const catalog = collections.catalog;
            const initial = await searchDistributedArtifactEvidenceWindow(catalog, {
                windowSize: ANALYZE_WORKER_EVIDENCE_WINDOW_SIZE,
            });
            if (!initial.ok) throw new Error('initial-window-unavailable');
            if (offered !== candidate || disposed) return;
            active = {
                generation: operationGeneration,
                model,
                catalog,
                sourceFileCount: decoded.sourceFileCount,
                sourceBytes: decoded.sourceBytes,
                parseDurationMs,
                pipelineTelemetry: prepared.pipelineTelemetry,
            };
            rpc.reset(0);
            const exportBytes = new TextEncoder().encode(JSON.stringify(
                model.portableEnvelope,
            )).buffer;
            const telemetry = analyzeWorkerTelemetry(
                active,
                initial.window,
                analyzeWorkerDuration(now(), startedAt),
            );
            const selectedId = model.firstActionableEvidenceId;
            const selected = selectedId
                ? catalog.entries.find(row => row.id === selectedId)
                : undefined;
            post({
                message: {
                    type: 'complete',
                    operationGeneration,
                    modelGeneration: operationGeneration,
                    projection: projectAnalyzeArtifactModel(model),
                    initialWindow: projectAnalyzeEvidenceWindow(initial.window),
                    ...(selected
                        ? { selected: projectAnalyzeEvidenceEntry(selected) }
                        : {}),
                    exportBytes,
                    telemetry,
                    ...(controlIdentityValidated
                        ? { controlIdentityValidated }
                        : {}),
                },
                transfer: [exportBytes],
            });
            offered = undefined;
        } catch (error) {
            if (offered !== candidate || disposed) return;
            fail(analyzeWorkerModelError(error), { operationGeneration });
        }
    }

    return { handle, dispose };
}
