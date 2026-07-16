import type { ClientPrincipalRef, ClientSnapshot } from '@shared/api/client-types.ts';
import { readClientStateRevision, readClientVersion } from '@shared/api/group-client-views.ts';
import {
    configureObservableLatestRepository,
    newObservableLatestRepositoryToken,
    readAllObservableLatestRepository,
    readObservableLatestRepositoryValue,
    requireObservableLatestRepository,
} from '@shared/cache/LatestRepositoryHelpers.ts';
import {
    ObservableLatestRepository,
    type ObservableLatestRepositoryOptions,
} from '@shared/cache/ObservableLatestRepository.ts';
import type { RepositoryManager } from '@shared/cache/RepositoryManager.ts';
import {
    type ObservableKeyedValueEvent,
    ObservableValueEventType,
    type ReadableKeyedValues,
} from '@shared/cache/RepositoryInterfaces.ts';
import { jsonEquals } from '@shared/repository/state-utils.ts';
import {
    decideStateSnapshotRevision,
    type StateSnapshotObservation,
    type StateSnapshotRevisionDecision,
    toStateSnapshotObservation,
} from './state-snapshot-revision.ts';

export type ClientStateSnapshotRepositoryOptions =
    & Omit<
        ObservableLatestRepositoryOptions<string, ClientSnapshot>,
        'ttlMs' | 'equals'
    >
    & { ttlMs: number };

export type ClientStateSnapshotWriteKind = ObservableValueEventType;

export type ClientStateSnapshotChange = Readonly<{
    kind: ClientStateSnapshotWriteKind;
    principalId: string;
    snapshot?: ClientSnapshot;
    previous?: ClientSnapshot;
    version: number;
    previousVersion?: number;
    manager?: RepositoryManager;
}>;

export type ClientStateSnapshotChangeListener = (
    change: ClientStateSnapshotChange,
) => void | Promise<void>;

export const clientStateSnapshotRepositoryToken = newObservableLatestRepositoryToken<
    string,
    ClientSnapshot
>(
    'shared.repository.client-state-snapshots',
    'Client state snapshot repository is not configured',
);

export function configureClientStateSnapshotRepository(
    options: ClientStateSnapshotRepositoryOptions,
    manager?: RepositoryManager,
): ObservableLatestRepository<string, ClientSnapshot> {
    return configureObservableLatestRepository(
        clientStateSnapshotRepositoryToken,
        {
            ...options,
            equals: (left, right) =>
                toClientSnapshotVersion(left) === toClientSnapshotVersion(right),
        },
        manager,
    );
}

export function onClientStateSnapshotChange(
    listener: ClientStateSnapshotChangeListener,
    manager?: RepositoryManager,
): () => void {
    const subscription = requireClientStateSnapshotRepository(manager)
        .onChangeDo(async (event) => {
            await listener(toClientStateSnapshotChange(event, manager));
        });
    return () => {
        subscription.unsubscribe();
    };
}

export async function waitForClientStateSnapshotChangesIdle(
    manager?: RepositoryManager,
): Promise<void> {
    await requireClientStateSnapshotRepository(manager).whenIdle();
}

function requireClientStateSnapshotRepository(
    manager?: RepositoryManager,
): ObservableLatestRepository<string, ClientSnapshot> {
    return requireObservableLatestRepository(clientStateSnapshotRepositoryToken, manager);
}

export function readableClientStateSnapshotCache(
    manager?: RepositoryManager,
): ReadableKeyedValues<string, ClientSnapshot> {
    return requireClientStateSnapshotRepository(manager).readable();
}

export function findClientStateSnapshotByPrincipalId(
    principalId: string,
    manager?: RepositoryManager,
): ClientSnapshot | undefined {
    return getAllClientStateSnapshots(manager)
        .filter((snapshot) => snapshot.principal.principalId === principalId)
        .toSorted((left, right) =>
            readClientStateRevision(right) - readClientStateRevision(left)
        )
        .at(0);
}

export function findClientStateSnapshotByRef(
    ref: ClientPrincipalRef,
    manager?: RepositoryManager,
): ClientSnapshot | undefined {
    return readObservableLatestRepositoryValue(
        clientStateSnapshotRepositoryToken,
        toClientStateSnapshotRepositoryKey(ref),
        manager,
    );
}

export function setClientStateSnapshots(
    snapshots: readonly ClientSnapshot[],
    manager?: RepositoryManager,
): boolean {
    let isAnyUpdated = false;
    for (const snapshot of snapshots) {
        if (
            setClientStateSnapshotByPrincipalId(
                snapshot.principal.principalId,
                snapshot,
                manager,
            )
        ) {
            isAnyUpdated = true;
        }
    }
    return isAnyUpdated;
}

export function setClientStateSnapshotByPrincipalId(
    principalId: string,
    snapshot: ClientSnapshot,
    manager?: RepositoryManager,
): boolean {
    const decision = writeClientStateSnapshot(snapshot, manager);
    return decision === 'inserted' || decision === 'advanced';
}

export function observeClientStateSnapshot(
    snapshot: ClientSnapshot,
    manager?: RepositoryManager,
): StateSnapshotObservation {
    return toStateSnapshotObservation(
        writeClientStateSnapshot(snapshot, manager),
    );
}

function writeClientStateSnapshot(
    snapshot: ClientSnapshot,
    manager?: RepositoryManager,
): StateSnapshotRevisionDecision {
    const repository = requireClientStateSnapshotRepository(manager);
    const repositoryKey = toClientStateSnapshotRepositoryKey(snapshot.principal);
    const current = repository.read(repositoryKey);
    const decision = decideStateSnapshotRevision({
        entity: 'Client',
        current,
        incoming: snapshot,
        stateRevisionOf: (value) => value.stateRevision,
        legacyVersionOf: toClientSnapshotVersion,
        equals: jsonEquals,
    });

    if (decision === 'inserted' || decision === 'advanced') {
        repository.set(repositoryKey, snapshot);
        if (decision === 'advanced') {
            console.log(
                `Received updated client snapshot: ${snapshot.principal.principalId}`,
            );
        }
        return decision;
    }

    if (decision === 'legacy-refreshed') {
        console.warn(
            `Received divergent legacy client snapshot at version ${toClientSnapshotVersion(snapshot)}: ${snapshot.principal.principalId}`,
        );
        repository.set(repositoryKey, snapshot);
    }

    return decision;
}

export function getAllClientStateSnapshots(
    manager?: RepositoryManager,
): ClientSnapshot[] {
    return readAllObservableLatestRepository(clientStateSnapshotRepositoryToken, manager);
}

function toClientSnapshotVersion(snapshot: ClientSnapshot): number {
    return readClientVersion(snapshot);
}

export function toClientStateSnapshotRepositoryKey(
    ref: ClientPrincipalRef,
): string {
    return JSON.stringify([
        ref.applicationId,
        ref.workspaceId ?? '',
        ref.principalId,
    ]);
}

function toClientStateSnapshotChange(
    event: ObservableKeyedValueEvent<string, ClientSnapshot>,
    manager?: RepositoryManager,
): ClientStateSnapshotChange {
    return {
        kind: event.type,
        principalId:
            event.value?.principal.principalId ??
            event.previous?.principal.principalId ??
            event.key,
        snapshot: event.value,
        previous: event.previous,
        version: event.value
            ? toClientSnapshotVersion(event.value)
            : event.previous
                ? toClientSnapshotVersion(event.previous)
                : 0,
        previousVersion: event.previous
            ? toClientSnapshotVersion(event.previous)
            : undefined,
        manager,
    };
}
