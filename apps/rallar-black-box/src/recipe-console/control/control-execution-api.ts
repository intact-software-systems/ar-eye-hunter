import type {
    ControlDistributedRunArtifactBundle,
    ControlDistributedRunSnapshot
} from '@shared-test/rallar-bb-test/control-snapshots.ts';
import type {
    RallarBlackBoxDistributedRunManifest,
    RallarBlackBoxDistributedTargetResolution
} from '@shared-test/rallar-bb-test/distributed-run.ts';
import {
    cancelDistributedRun,
    createDistributedRun,
    fetchDistributedRunArtifactBundle,
    fetchDistributedRunArtifactBundleBytes,
    resolveDistributedTargets,
    stageDistributedRun,
    startDistributedRun
} from '../../control-run-manager.ts';
import type { ControlAuthorizedTransport } from './control-authorized-transport.ts';
import {
    validateControlExecutionArtifactBundle,
    validateControlExecutionRun,
    validateControlExecutionTargetResolution
} from './control-execution-validation.ts';

type ExecutionSignal = Readonly<{ signal?: AbortSignal; }>;
type ManifestExecutionInput =
    & ExecutionSignal
    & Readonly<{
        manifest: RallarBlackBoxDistributedRunManifest;
    }>;
type RunExecutionInput =
    & ExecutionSignal
    & Readonly<{
        distributedRunId: string;
    }>;
type CancelExecutionInput = RunExecutionInput & Readonly<{ reason?: string; }>;

export const RECIPE_CONSOLE_CONTROL_ARTIFACT_TRANSFER_MAX_BYTES = 64 * 1024 * 1024;

export type RecipeConsoleControlArtifactBytes = Readonly<{
    distributedRunId: string;
    bytes: ArrayBuffer;
}>;

export type RecipeConsoleControlExecutionApi = Readonly<{
    resolveTargets(
        input: ManifestExecutionInput
    ): Promise<RallarBlackBoxDistributedTargetResolution>;
    createRun(
        input: ManifestExecutionInput
    ): Promise<ControlDistributedRunSnapshot>;
    stageRun(input: RunExecutionInput): Promise<ControlDistributedRunSnapshot>;
    startRun(input: RunExecutionInput): Promise<ControlDistributedRunSnapshot>;
    cancelRun(input: CancelExecutionInput): Promise<ControlDistributedRunSnapshot>;
    exportRunArtifact(
        input: RunExecutionInput
    ): Promise<ControlDistributedRunArtifactBundle>;
    exportRunArtifactBytes(
        input: RunExecutionInput
    ): Promise<RecipeConsoleControlArtifactBytes>;
}>;

export function createRecipeConsoleControlExecutionApi(
    input: Readonly<{
        baseUrl: string;
        transport: ControlAuthorizedTransport;
    }>
): RecipeConsoleControlExecutionApi {
    const writeAuthorization = input.transport.createEndpointAuthorization();
    const artifactAuthorization = input.transport.createEndpointAuthorization();

    return {
        async resolveTargets(request) {
            const result = await input.transport.response(
                async (token, fetchFn) => {
                    const value = await resolveDistributedTargets({
                        baseUrl: input.baseUrl,
                        manifest: request.manifest,
                        token,
                        fetchFn
                    });
                    validateControlExecutionTargetResolution(value);
                    return value;
                },
                writeAuthorization,
                request.signal
            );
            return result.value;
        },
        async createRun(request) {
            return runMutation(
                (token, fetchFn) =>
                    createDistributedRun({
                        baseUrl: input.baseUrl,
                        manifest: request.manifest,
                        token,
                        fetchFn
                    }),
                request.signal
            );
        },
        async stageRun(request) {
            return runMutation(
                (token, fetchFn) =>
                    stageDistributedRun({
                        baseUrl: input.baseUrl,
                        distributedRunId: request.distributedRunId,
                        token,
                        fetchFn
                    }),
                request.signal
            );
        },
        async startRun(request) {
            return runMutation(
                (token, fetchFn) =>
                    startDistributedRun({
                        baseUrl: input.baseUrl,
                        distributedRunId: request.distributedRunId,
                        token,
                        fetchFn
                    }),
                request.signal
            );
        },
        async cancelRun(request) {
            return runMutation(
                (token, fetchFn) =>
                    cancelDistributedRun({
                        baseUrl: input.baseUrl,
                        distributedRunId: request.distributedRunId,
                        reason: request.reason,
                        token,
                        fetchFn
                    }),
                request.signal
            );
        },
        async exportRunArtifact(request) {
            const result = await input.transport.response(
                async (token, fetchFn) => {
                    const value = await fetchDistributedRunArtifactBundle({
                        baseUrl: input.baseUrl,
                        distributedRunId: request.distributedRunId,
                        token,
                        fetchFn
                    });
                    validateControlExecutionArtifactBundle(value);
                    return value;
                },
                artifactAuthorization,
                request.signal
            );
            return result.value;
        },
        async exportRunArtifactBytes(request) {
            const result = await input.transport.response(
                (token, fetchFn) =>
                    fetchDistributedRunArtifactBundleBytes({
                        baseUrl: input.baseUrl,
                        distributedRunId: request.distributedRunId,
                        token,
                        fetchFn,
                        maxBytes: RECIPE_CONSOLE_CONTROL_ARTIFACT_TRANSFER_MAX_BYTES
                    }),
                artifactAuthorization,
                request.signal
            );
            return {
                distributedRunId: request.distributedRunId,
                bytes: result.value
            };
        }
    };

    async function runMutation(
        operation: Parameters<ControlAuthorizedTransport['response']>[0],
        signal: AbortSignal | undefined
    ): Promise<ControlDistributedRunSnapshot> {
        const result = await input.transport.response(
            async (token, fetchFn) => {
                const value = await operation(token, fetchFn) as ControlDistributedRunSnapshot;
                validateControlExecutionRun(value);
                return value;
            },
            writeAuthorization,
            signal
        );
        return result.value;
    }
}
