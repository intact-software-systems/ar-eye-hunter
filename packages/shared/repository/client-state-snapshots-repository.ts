import type { ClientSnapshot } from '@shared/api/client-types.ts';
import { readClientVersion } from '@shared/api/group-client-views.ts';
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
    return readObservableLatestRepositoryValue(
        clientStateSnapshotRepositoryToken,
        principalId,
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
    const repository = requireClientStateSnapshotRepository(manager);
    const current = repository.read(principalId);
    const nextVersion = toClientSnapshotVersion(snapshot);
    const currentVersion = current
        ? toClientSnapshotVersion(current)
        : undefined;

    if (!current) {
        repository.set(principalId, snapshot);
        return true;
    }

    if (currentVersion !== undefined && nextVersion > currentVersion) {
        repository.set(principalId, snapshot);
        console.log(`Received updated client snapshot: ${principalId}`);
        return true;
    }

    if (currentVersion === nextVersion && !jsonEquals(current, snapshot)) {
        repository.set(principalId, snapshot);
    }

    return false;
}

export function getAllClientStateSnapshots(
    manager?: RepositoryManager,
): ClientSnapshot[] {
    return readAllObservableLatestRepository(clientStateSnapshotRepositoryToken, manager);
}

function toClientSnapshotVersion(snapshot: ClientSnapshot): number {
    return readClientVersion(snapshot);
}

function toClientStateSnapshotChange(
    event: ObservableKeyedValueEvent<string, ClientSnapshot>,
    manager?: RepositoryManager,
): ClientStateSnapshotChange {
    return {
        kind: event.type,
        principalId: event.key,
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
