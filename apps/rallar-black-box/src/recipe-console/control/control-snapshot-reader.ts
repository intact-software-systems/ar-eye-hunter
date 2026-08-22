import type {
    ControlRunSnapshot,
    ControlServerSnapshot,
    ControlSnapshotBounds
} from '@shared-test/rallar-bb-test/control-snapshots.ts';
import {
    fetchControlRunSnapshot,
    fetchControlServerSnapshot,
    fetchDistributedRuns
} from '../../control-run-manager.ts';
import { isControlAbortError } from './control-authorized-fetch.ts';
import type { ControlAuthorizedTransport, RecipeConsoleControlAuthorization } from './control-authorized-transport.ts';
import { mergeControlRunDetails } from './control-detail-run-ids.ts';
import { createControlSnapshotRevisionSession } from './control-snapshot-revision.ts';
import {
    validateControlDistributedRuns,
    validateControlRunSnapshot,
    validateControlServerCoreSnapshot,
    withoutDistributedRuns
} from './control-snapshot-validation.ts';

export type RecipeConsoleControlDistributedRunsSource =
    | 'root-snapshot'
    | 'canonical-fallback'
    | 'unavailable';

export type RecipeConsoleControlRunEvidenceProvenance = Readonly<{
    detailedRunIds: readonly string[];
    indexOnlyRunIds: readonly string[];
}>;

export type RecipeConsoleControlSnapshotResult = Readonly<{
    snapshot: ControlServerSnapshot;
    completeness: 'complete' | 'partial';
    distributedRunsSource: RecipeConsoleControlDistributedRunsSource;
    authorization: RecipeConsoleControlAuthorization;
    runEvidence: RecipeConsoleControlRunEvidenceProvenance;
    partialError?: unknown;
}>;

export type RecipeConsoleControlQueryProvenance = Readonly<{
    distributedRunsSource: RecipeConsoleControlDistributedRunsSource;
    runEvidence: RecipeConsoleControlRunEvidenceProvenance;
}>;

export type ControlSnapshotReader = (
    input?: Readonly<{ signal?: AbortSignal; }>
) => Promise<RecipeConsoleControlSnapshotResult>;

export type ControlSnapshotReaderConfig = Readonly<{
    baseUrl: string;
    indexBounds: ControlSnapshotBounds;
    detailBounds: ControlSnapshotBounds;
    detailRunIds?(snapshot: ControlServerSnapshot): readonly string[];
    transport: ControlAuthorizedTransport;
    protocolError(error: unknown): Error;
    isProtocolCandidate(error: unknown): boolean;
}>;

export function createControlSnapshotReader(
    config: ControlSnapshotReaderConfig
): ControlSnapshotReader {
    const runsAuthorization = config.transport.createEndpointAuthorization();
    const distributedRunsAuthorization = config.transport.createEndpointAuthorization();
    const revisionSession = createControlSnapshotRevisionSession();

    return async function readSnapshot (input = {}) {
        const server = await config.transport.response(
            (token, fetchFn) =>
                fetchControlServerSnapshot({
                    baseUrl: config.baseUrl,
                    token,
                    bounds: config.indexBounds,
                    fetchFn
                }),
            runsAuthorization,
            input.signal
        );
        try {
            validateControlServerCoreSnapshot(server.value);
        }
        catch (error) {
            throw config.protocolError(error);
        }

        let snapshot = server.value;
        let completeness: RecipeConsoleControlSnapshotResult['completeness'] = 'complete';
        let distributedRunsSource: RecipeConsoleControlDistributedRunsSource = 'root-snapshot';
        let authorization = server.authorization;
        let partialError: unknown;
        let fallbackDocument: unknown;

        if (server.value.distributedRuns !== undefined) {
            try {
                validateControlDistributedRuns(server.value.distributedRuns);
            }
            catch (error) {
                snapshot = withoutDistributedRuns(server.value);
                completeness = 'partial';
                distributedRunsSource = 'unavailable';
                partialError = config.protocolError(error);
            }
        }
        else {
            try {
                const distributed = await config.transport.response(
                    (token, fetchFn) =>
                        fetchDistributedRuns({
                            baseUrl: config.baseUrl,
                            token,
                            fetchFn
                        }),
                    distributedRunsAuthorization,
                    input.signal
                );
                validateControlDistributedRuns(distributed.value);
                snapshot = {
                    ...server.value,
                    distributedRuns: distributed.value
                };
                validateControlServerCoreSnapshot(snapshot);
                distributedRunsSource = 'canonical-fallback';
                authorization = combinedAuthorization(
                    server.authorization,
                    distributed.authorization
                );
                fallbackDocument = distributed.value;
            }
            catch (error) {
                if (input.signal?.aborted || isControlAbortError(error)) {
                    throw error;
                }
                completeness = 'partial';
                distributedRunsSource = 'unavailable';
                partialError = config.isProtocolCandidate(error)
                    ? config.protocolError(error)
                    : error;
            }
        }

        const requestedRunIds = requestedDetailRunIds(
            snapshot,
            config.detailRunIds?.(snapshot) ?? []
        );
        const detailRuns: ControlRunSnapshot[] = [];
        for (const runId of requestedRunIds) {
            const detail = await config.transport.response(
                async (token, fetchFn) => {
                    const value = await fetchControlRunSnapshot({
                        baseUrl: config.baseUrl,
                        runId,
                        token,
                        bounds: config.detailBounds,
                        fetchFn
                    });
                    validateControlRunSnapshot(value);
                    return value;
                },
                runsAuthorization,
                input.signal
            );
            authorization = combinedAuthorization(
                authorization,
                detail.authorization
            );
            detailRuns.push(detail.value);
        }

        const mergedSnapshot = detailRuns.length > 0
            ? mergeControlRunDetails(snapshot, detailRuns)
            : snapshot;
        const detailedRunIds = detailRuns.map((run) => run.runId);
        const detailed = new Set(detailedRunIds);
        const runEvidence = {
            detailedRunIds,
            indexOnlyRunIds: mergedSnapshot.runs
                .map((run) => run.runId)
                .filter((runId) => !detailed.has(runId))
        };
        revisionSession.associate(mergedSnapshot, {
            source: distributedRunsSource,
            rootDocument: server.value,
            fallbackDocument,
            detailDocuments: detailRuns
        });
        return {
            snapshot: mergedSnapshot,
            completeness,
            distributedRunsSource,
            authorization,
            runEvidence,
            ...(partialError === undefined ? {} : { partialError })
        };
    };
}

function requestedDetailRunIds(
    snapshot: ControlServerSnapshot,
    requested: readonly string[]
): readonly string[] {
    const available = new Set(snapshot.runs.map((run) => run.runId));
    return [...new Set(requested)].filter((runId) => available.has(runId));
}

function combinedAuthorization(
    left: RecipeConsoleControlAuthorization,
    right: RecipeConsoleControlAuthorization
): RecipeConsoleControlAuthorization {
    if (left === 'manual' || right === 'manual') {
        return 'manual';
    }
    if (left === 'brokered' || right === 'brokered') {
        return 'brokered';
    }
    return 'anonymous';
}
