import type {
    ControlServerSnapshot,
    ControlSnapshotBounds,
} from '@shared-test/rallar-bb-test/control-snapshots.ts';
import {
    fetchControlServerSnapshot,
    fetchDistributedRuns,
} from '../../control-run-manager.ts';
import type {
    ControlAuthorizedTransport,
    RecipeConsoleControlAuthorization,
} from './control-authorized-transport.ts';
import { isControlAbortError } from './control-authorized-fetch.ts';
import {
    validateControlDistributedRuns,
    validateControlServerCoreSnapshot,
    withoutDistributedRuns,
} from './control-snapshot-validation.ts';
import { createControlSnapshotRevisionSession } from './control-snapshot-revision.ts';

export type RecipeConsoleControlDistributedRunsSource =
    | 'root-snapshot'
    | 'canonical-fallback'
    | 'unavailable';

export type RecipeConsoleControlSnapshotResult = Readonly<{
    snapshot: ControlServerSnapshot;
    completeness: 'complete' | 'partial';
    distributedRunsSource: RecipeConsoleControlDistributedRunsSource;
    authorization: RecipeConsoleControlAuthorization;
    partialError?: unknown;
}>;

export type RecipeConsoleControlQueryProvenance = Readonly<{
    distributedRunsSource: RecipeConsoleControlDistributedRunsSource;
}>;

export type ControlSnapshotReader = (
    input?: Readonly<{ signal?: AbortSignal }>,
) => Promise<RecipeConsoleControlSnapshotResult>;

export type ControlSnapshotReaderConfig = Readonly<{
    baseUrl: string;
    bounds: ControlSnapshotBounds;
    transport: ControlAuthorizedTransport;
    protocolError(error: unknown): Error;
    isProtocolCandidate(error: unknown): boolean;
}>;

export function createControlSnapshotReader(
    config: ControlSnapshotReaderConfig,
): ControlSnapshotReader {
    const runsAuthorization = config.transport.createEndpointAuthorization();
    const distributedRunsAuthorization =
        config.transport.createEndpointAuthorization();
    const revisionSession = createControlSnapshotRevisionSession();

    return async function readSnapshot(input = {}) {
        const server = await config.transport.response(
            (token, fetchFn) =>
                fetchControlServerSnapshot({
                    baseUrl: config.baseUrl,
                    token,
                    bounds: config.bounds,
                    fetchFn,
                }),
            runsAuthorization,
            input.signal,
        );
        try {
            validateControlServerCoreSnapshot(server.value);
        } catch (error) {
            throw config.protocolError(error);
        }

        if (server.value.distributedRuns !== undefined) {
            try {
                validateControlDistributedRuns(server.value.distributedRuns);
            } catch (error) {
                const snapshot = withoutDistributedRuns(server.value);
                revisionSession.associate(snapshot, {
                    source: 'unavailable',
                    rootDocument: server.value,
                });
                return {
                    snapshot,
                    completeness: 'partial',
                    distributedRunsSource: 'unavailable',
                    authorization: server.authorization,
                    partialError: config.protocolError(error),
                };
            }
            revisionSession.associate(server.value, {
                source: 'root-snapshot',
                rootDocument: server.value,
            });
            return {
                snapshot: server.value,
                completeness: 'complete',
                distributedRunsSource: 'root-snapshot',
                authorization: server.authorization,
            };
        }

        try {
            const distributed = await config.transport.response(
                (token, fetchFn) =>
                    fetchDistributedRuns({
                        baseUrl: config.baseUrl,
                        token,
                        fetchFn,
                    }),
                distributedRunsAuthorization,
                input.signal,
            );
            validateControlDistributedRuns(distributed.value);
            const snapshot: ControlServerSnapshot = {
                ...server.value,
                distributedRuns: distributed.value,
            };
            validateControlServerCoreSnapshot(snapshot);
            revisionSession.associate(snapshot, {
                source: 'canonical-fallback',
                rootDocument: server.value,
                fallbackDocument: distributed.value,
            });
            return {
                snapshot,
                completeness: 'complete',
                distributedRunsSource: 'canonical-fallback',
                authorization: combinedAuthorization(
                    server.authorization,
                    distributed.authorization,
                ),
            };
        } catch (partialError) {
            if (input.signal?.aborted || isControlAbortError(partialError)) {
                throw partialError;
            }
            const normalizedPartialError =
                config.isProtocolCandidate(partialError)
                    ? config.protocolError(partialError)
                    : partialError;
            revisionSession.associate(server.value, {
                source: 'unavailable',
                rootDocument: server.value,
            });
            return {
                snapshot: server.value,
                completeness: 'partial',
                distributedRunsSource: 'unavailable',
                authorization: server.authorization,
                partialError: normalizedPartialError,
            };
        }
    };
}

function combinedAuthorization(
    left: RecipeConsoleControlAuthorization,
    right: RecipeConsoleControlAuthorization,
): RecipeConsoleControlAuthorization {
    if (left === 'manual' || right === 'manual') return 'manual';
    if (left === 'brokered' || right === 'brokered') return 'brokered';
    return 'anonymous';
}
