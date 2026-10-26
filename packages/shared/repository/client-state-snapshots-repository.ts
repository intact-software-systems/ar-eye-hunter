import type { ClientPrincipalRef, ClientSnapshot } from '@shared/api/client-types.ts';
import { readClientStateRevision, readClientVersion } from '@shared/api/group-client-views.ts';
import {
    configureObservableLatestRepository,
    newObservableLatestRepositoryToken,
    readAllObservableLatestRepository,
    readObservableLatestRepositoryValue,
    requireObservableLatestRepository
} from '@shared/cache/configure-latest-repository.ts';
import {
    ObservableLatestRepository,
    type ObservableLatestRepositoryOptions
} from '@shared/cache/observable/observable-latest-repository.ts';
import {
    ObservableValueEventType,
    type ObservableKeyedValueEvent,
    type ReadableKeyedValues
} from '@shared/cache/RepositoryInterfaces.ts';
import type { RepositoryManager } from '@shared/cache/RepositoryManager.ts';
import { jsonEquals } from '@shared/repository/state-utils.ts';
import { toClientStateSnapshotRepositoryKey } from './client-state-snapshot-repository-key.ts';
import {
    decideStateSnapshotRevision,
    toStateSnapshotObservation,
    type StateSnapshotObservation,
    type StateSnapshotRevisionDecision
} from './state-snapshot-revision.ts';

export {
    type ClientStateSnapshotRepositoryRef,
    fromClientStateSnapshotRepositoryKey,
    toClientStateSnapshotRepositoryKey
} from './client-state-snapshot-repository-key.ts';

export type ClientStateSnapshotRepositoryOptions =
    & Omit<ObservableLatestRepositoryOptions<string, ClientSnapshot>, 'ttlMs' | 'equals'>
    & { ttlMs: number; };

export interface ClientStateSnapshotChange {
    readonly kind: ObservableValueEventType;
    readonly principalId: string;
    readonly snapshot?: ClientSnapshot;
    readonly previous?: ClientSnapshot;
    readonly version: number;
    readonly previousVersion?: number;
    readonly manager?: RepositoryManager;
}

export type ClientStateSnapshotChangeListener = (
    change: ClientStateSnapshotChange
) => void | Promise<void>;

export const clientStateSnapshotRepositoryToken = newObservableLatestRepositoryToken<string, ClientSnapshot>(
    'shared.repository.client-state-snapshots',
    'Client state snapshot repository is not configured'
);

export function configureClientStateSnapshotRepository(
    options: ClientStateSnapshotRepositoryOptions,
    manager?: RepositoryManager
): ObservableLatestRepository<string, ClientSnapshot> {
    return configureObservableLatestRepository(
        clientStateSnapshotRepositoryToken,
        {
            ...options,
            equals: (left, right) => readClientStateRevision(left) === readClientStateRevision(right)
        },
        manager
    );
}

export function onClientStateSnapshotChange(
    listener: ClientStateSnapshotChangeListener,
    manager?: RepositoryManager
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
    manager?: RepositoryManager
): Promise<void> {
    await requireClientStateSnapshotRepository(manager).whenIdle();
}

function requireClientStateSnapshotRepository(
    manager?: RepositoryManager
): ObservableLatestRepository<string, ClientSnapshot> {
    return requireObservableLatestRepository(clientStateSnapshotRepositoryToken, manager);
}

export function readableClientStateSnapshotCache(
    manager?: RepositoryManager
): ReadableKeyedValues<string, ClientSnapshot> {
    return requireClientStateSnapshotRepository(manager).readable();
}

export function findClientStateSnapshotByPrincipalId(
    principalId: string,
    manager?: RepositoryManager
): ClientSnapshot | undefined {
    return getAllClientStateSnapshots(manager)
        .filter((snapshot) => snapshot.principal.principalId === principalId)
        .toSorted((left, right) => readClientStateRevision(right) - readClientStateRevision(left))
        .at(0);
}

export function findClientStateSnapshotByRef(
    ref: ClientPrincipalRef,
    manager?: RepositoryManager
): ClientSnapshot | undefined {
    return readObservableLatestRepositoryValue(
        clientStateSnapshotRepositoryToken,
        toClientStateSnapshotRepositoryKey(ref),
        manager
    );
}

export function setClientStateSnapshots(
    snapshots: readonly ClientSnapshot[],
    manager?: RepositoryManager
): boolean {
    let isAnyUpdated = false;
    for (const snapshot of snapshots) {
        if (
            setClientStateSnapshotByPrincipalId(
                snapshot.principal.principalId,
                snapshot,
                manager
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
    manager?: RepositoryManager
): boolean {
    const decision = writeClientStateSnapshot(snapshot, manager);
    return decision === 'inserted' || decision === 'advanced';
}

export function removeClientStateSnapshotIfUnchanged(
    ref: ClientPrincipalRef,
    expected: ClientSnapshot,
    manager?: RepositoryManager
): boolean {
    return requireClientStateSnapshotRepository(manager).compareAndDelete(
        toClientStateSnapshotRepositoryKey(ref),
        expected
    );
}

export function observeClientStateSnapshot(
    snapshot: ClientSnapshot,
    manager?: RepositoryManager
): StateSnapshotObservation {
    return toStateSnapshotObservation(
        writeClientStateSnapshot(snapshot, manager)
    );
}

function writeClientStateSnapshot(
    snapshot: ClientSnapshot,
    manager?: RepositoryManager
): StateSnapshotRevisionDecision {
    const repository = requireClientStateSnapshotRepository(manager);
    const repositoryKey = toClientStateSnapshotRepositoryKey(snapshot.principal);
    const current = repository.read(repositoryKey);
    const decision = decideStateSnapshotRevision({
        entity: 'Client',
        current,
        incoming: snapshot,
        stateRevisionOf: (value) => value.stateRevision,
        equals: jsonEquals
    });

    if (decision === 'inserted' || decision === 'advanced') {
        repository.set(repositoryKey, snapshot);
        return decision;
    }

    return decision;
}

export function getAllClientStateSnapshots(
    manager?: RepositoryManager
): ClientSnapshot[] {
    return readAllObservableLatestRepository(clientStateSnapshotRepositoryToken, manager);
}

function toClientStateSnapshotChange(
    event: ObservableKeyedValueEvent<string, ClientSnapshot>,
    manager?: RepositoryManager
): ClientStateSnapshotChange {
    return {
        kind: event.type,
        principalId: event.value?.principal.principalId ??
            event.previous?.principal.principalId ??
            event.key,
        snapshot: event.value,
        previous: event.previous,
        version: event.value
            ? readClientVersion(event.value)
            : event.previous
            ? readClientVersion(event.previous)
            : 0,
        previousVersion: event.previous
            ? readClientVersion(event.previous)
            : undefined,
        manager
    };
}
