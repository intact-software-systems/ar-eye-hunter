import type { ClientPrincipalRef, ClientSnapshot } from '@shared/api/client-types.ts';
import { Either } from '@shared/resilience/Either.ts';
import type { StateSnapshotObservation } from '@shared/repository/state-snapshot-revision.ts';
import type {
    ClientMutationWritten,
    ClientStateService,
    ClientStateWritten,
} from './client-state-service.ts';

export type CachedClientStateServiceCache = Readonly<{
    findOrLoadByRef(ref: ClientPrincipalRef): Promise<ClientSnapshot | undefined>;
    observe(snapshot: ClientSnapshot): StateSnapshotObservation;
}>;

export type CachedClientStateService = ClientStateService & Readonly<{
    observeSnapshot(snapshot: ClientSnapshot): Promise<ClientSnapshot>;
}>;

export function createCachedClientStateService(options: Readonly<{
    durable: ClientStateService;
    cache: CachedClientStateServiceCache;
}>): CachedClientStateService {
    const observeSnapshot = async (
        snapshot: ClientSnapshot,
    ): Promise<ClientSnapshot> => {
        options.cache.observe(snapshot);
        return snapshot;
    };
    const observeWritten = async (
        written: ClientStateWritten,
    ): Promise<ClientStateWritten> => {
        if (!written.result.right) {
            return written;
        }
        const mutation: ClientMutationWritten = {
            ...written.result.right,
            snapshot: await observeSnapshot(written.result.right.snapshot),
        };
        return {
            ...written,
            result: Either.ofRight(mutation),
        };
    };
    const observeWrittenList = async (
        values: readonly ClientStateWritten[],
    ): Promise<readonly ClientStateWritten[]> =>
        await Promise.all(values.map(observeWritten));

    const service: CachedClientStateService = {
        ...options.durable,
        observeSnapshot,
        listSnapshots: async (scope) => {
            const snapshots = await options.durable.listSnapshots(scope);
            return await Promise.all(snapshots.map(observeSnapshot));
        },
        readSnapshot: async (ref) =>
            await options.cache.findOrLoadByRef(ref),
        upsertPrincipal: async (scope, principalId, request) =>
            await observeWritten(
                await options.durable.upsertPrincipal(
                    scope,
                    principalId,
                    request,
                ),
            ),
        upsertInstance: async (
            scope,
            principalId,
            clientInstanceId,
            request,
        ) =>
            await observeWritten(
                await options.durable.upsertInstance(
                    scope,
                    principalId,
                    clientInstanceId,
                    request,
                ),
            ),
        connectSession: async (
            scope,
            principalId,
            clientInstanceId,
            sessionId,
            request,
        ) =>
            await observeWritten(
                await options.durable.connectSession(
                    scope,
                    principalId,
                    clientInstanceId,
                    sessionId,
                    request,
                ),
            ),
        heartbeatSession: async (
            scope,
            principalId,
            clientInstanceId,
            sessionId,
            request,
        ) =>
            await observeWritten(
                await options.durable.heartbeatSession(
                    scope,
                    principalId,
                    clientInstanceId,
                    sessionId,
                    request,
                ),
            ),
        disconnectSession: async (
            scope,
            principalId,
            clientInstanceId,
            sessionId,
            request,
        ) =>
            await observeWritten(
                await options.durable.disconnectSession(
                    scope,
                    principalId,
                    clientInstanceId,
                    sessionId,
                    request,
                ),
            ),
        registerAuthorisedWsClientSession: async (authSession, input) =>
            await observeWritten(
                await options.durable.registerAuthorisedWsClientSession(
                    authSession,
                    input,
                ),
            ),
        disconnectAuthorisedWsClientSession: async (sessionId, reason) =>
            await observeWritten(
                await options.durable.disconnectAuthorisedWsClientSession(
                    sessionId,
                    reason,
                ),
            ),
        expireExpiredSessions: async (atEpochMs) =>
            await observeWrittenList(
                await options.durable.expireExpiredSessions(atEpochMs),
            ),
    };

    return service;
}
