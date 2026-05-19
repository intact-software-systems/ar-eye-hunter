import type { GroupRef, GroupSnapshot } from '@shared/api/group-types.ts';
import { readGroupVersion } from '@shared/api/group-client-views.ts';
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

export type GroupStateSnapshotRepositoryOptions =
    & Omit<
        ObservableLatestRepositoryOptions<string, GroupSnapshot>,
        'ttlMs' | 'equals'
    >
    & { ttlMs: number };

export type GroupStateSnapshotWriteKind = ObservableValueEventType;

export type GroupStateSnapshotChange = Readonly<{
    kind: GroupStateSnapshotWriteKind;
    groupRef: GroupRef;
    snapshot?: GroupSnapshot;
    previous?: GroupSnapshot;
    version: number;
    previousVersion?: number;
    manager?: RepositoryManager;
}>;

export type GroupStateSnapshotChangeListener = (
    change: GroupStateSnapshotChange,
) => void | Promise<void>;

export const groupStateSnapshotRepositoryToken = newObservableLatestRepositoryToken<
    string,
    GroupSnapshot
>(
    'shared.repository.group-state-snapshots',
    'Group state snapshot repository is not configured',
);

export function configureGroupStateSnapshotRepository(
    options: GroupStateSnapshotRepositoryOptions,
    manager?: RepositoryManager,
): ObservableLatestRepository<string, GroupSnapshot> {
    return configureObservableLatestRepository(
        groupStateSnapshotRepositoryToken,
        {
            ...options,
            equals: (left, right) =>
                toGroupSnapshotVersion(left) === toGroupSnapshotVersion(right),
        },
        manager,
    );
}

export function onGroupStateSnapshotChange(
    listener: GroupStateSnapshotChangeListener,
    manager?: RepositoryManager,
): () => void {
    const subscription = requireGroupStateSnapshotRepository(manager)
        .onChangeDo(async (event) => {
            await listener(toGroupStateSnapshotChange(event, manager));
        });
    return () => {
        subscription.unsubscribe();
    };
}

export async function waitForGroupStateSnapshotChangesIdle(
    manager?: RepositoryManager,
): Promise<void> {
    await requireGroupStateSnapshotRepository(manager).whenIdle();
}

function requireGroupStateSnapshotRepository(
    manager?: RepositoryManager,
): ObservableLatestRepository<string, GroupSnapshot> {
    return requireObservableLatestRepository(groupStateSnapshotRepositoryToken, manager);
}

export function readableGroupStateSnapshotCache(
    manager?: RepositoryManager,
): ReadableKeyedValues<string, GroupSnapshot> {
    return requireGroupStateSnapshotRepository(manager).readable();
}

export function findGroupStateSnapshotByRef(
    ref: GroupRef,
    manager?: RepositoryManager,
): GroupSnapshot | undefined {
    return readObservableLatestRepositoryValue(
        groupStateSnapshotRepositoryToken,
        toGroupStateSnapshotRepositoryKey(ref),
        manager,
    );
}

export function findFirstGroupStateSnapshotRefSessionIdIsIn(
    sessionId: string,
    manager?: RepositoryManager,
): GroupRef | undefined {
    return readAllObservableLatestRepository(groupStateSnapshotRepositoryToken, manager)
        .find((snapshot) =>
            snapshot.activeSessions.some((activeSession) => activeSession.sessionId === sessionId)
        )
        ?.group;
}

export function setGroupStateSnapshots(
    snapshots: readonly GroupSnapshot[],
    manager?: RepositoryManager,
): boolean {
    let isAnyUpdated = false;
    for (const snapshot of snapshots) {
        if (setGroupStateSnapshot(snapshot, manager)) {
            isAnyUpdated = true;
        }
    }
    return isAnyUpdated;
}

export function setGroupStateSnapshot(
    snapshot: GroupSnapshot,
    manager?: RepositoryManager,
): boolean {
    const repository = requireGroupStateSnapshotRepository(manager);
    const repositoryKey = toGroupStateSnapshotRepositoryKey(snapshot.group);
    const current = repository.read(repositoryKey);
    const nextVersion = toGroupSnapshotVersion(snapshot);
    const currentVersion = current
        ? toGroupSnapshotVersion(current)
        : undefined;

    if (!current) {
        repository.set(repositoryKey, snapshot);
        return true;
    }

    if (currentVersion !== undefined && nextVersion > currentVersion) {
        repository.set(repositoryKey, snapshot);
        console.log(`Received updated group snapshot: ${snapshot.group.groupId}`);
        return true;
    }

    if (currentVersion === nextVersion && !jsonEquals(current, snapshot)) {
        repository.set(repositoryKey, snapshot);
    }

    return false;
}

export function getAllGroupStateSnapshots(
    manager?: RepositoryManager,
): GroupSnapshot[] {
    return readAllObservableLatestRepository(groupStateSnapshotRepositoryToken, manager);
}

export function findLatestGroupSnapshotById(groupId: string) {
    return getAllGroupStateSnapshots()
        .filter((snapshot) => snapshot.group.groupId === groupId)
        .sort((left, right) => readGroupVersion(right) - readGroupVersion(left))
        .at(0);
}

function toGroupSnapshotVersion(snapshot: GroupSnapshot): number {
    return readGroupVersion(snapshot);
}

export function toGroupStateSnapshotRepositoryKey(ref: GroupRef): string {
    return JSON.stringify([
        ref.applicationId,
        ref.workspaceId ?? '',
        ref.groupId,
    ]);
}

function toGroupStateSnapshotChange(
    event: ObservableKeyedValueEvent<string, GroupSnapshot>,
    manager?: RepositoryManager,
): GroupStateSnapshotChange {
    const snapshot = event.value ?? event.previous;
    if (!snapshot) {
        throw new Error(
            `Cannot build group snapshot change without a snapshot for key ${event.key}`,
        );
    }

    return {
        kind: event.type,
        groupRef: snapshot.group,
        snapshot: event.value,
        previous: event.previous,
        version: event.value
            ? toGroupSnapshotVersion(event.value)
            : event.previous
                ? toGroupSnapshotVersion(event.previous)
                : 0,
        previousVersion: event.previous
            ? toGroupSnapshotVersion(event.previous)
            : undefined,
        manager,
    };
}

function jsonEquals(left: unknown, right: unknown): boolean {
    return stableJsonStringify(left) === stableJsonStringify(right);
}

function stableJsonStringify(value: unknown): string {
    return JSON.stringify(toStableJson(value));
}

function toStableJson(value: unknown): unknown {
    if (Array.isArray(value)) {
        return value.map(toStableJson);
    }
    if (!value || typeof value !== 'object') {
        return value;
    }

    return Object.fromEntries(
        Object.entries(value as Record<string, unknown>)
            .sort(([left], [right]) => left.localeCompare(right))
            .map(([key, entryValue]) => [key, toStableJson(entryValue)]),
    );
}
