import type { GroupRef, GroupSnapshot } from '@shared/api/group-types.ts';
import { readGroupStateRevision, readGroupVersion } from '@shared/api/group-client-views.ts';
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

type GroupSessionIndex = Map<string, Set<string>>;

const groupSessionIndexes = new WeakMap<
    ObservableLatestRepository<string, GroupSnapshot>,
    GroupSessionIndex
>();

export function configureGroupStateSnapshotRepository(
    options: GroupStateSnapshotRepositoryOptions,
    manager?: RepositoryManager,
): ObservableLatestRepository<string, GroupSnapshot> {
    const repository = configureObservableLatestRepository(
        groupStateSnapshotRepositoryToken,
        {
            ...options,
            equals: (left, right) =>
                readGroupStateRevision(left) === readGroupStateRevision(right),
        },
        manager,
    );
    groupSessionIndexes.set(repository, new Map());
    return repository;
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

export function findGroupStateSnapshotsBySessionIds(
    sessionIds: readonly string[],
    manager?: RepositoryManager,
): GroupSnapshot[] {
    const uniqueSessionIds = [...new Set(sessionIds)];
    if (uniqueSessionIds.length === 0) {
        return [];
    }

    const repository = requireGroupStateSnapshotRepository(manager);
    const index = groupSessionIndexForRepository(repository);
    const sessionGroupKeys = uniqueSessionIds.map((sessionId) =>
        index.get(sessionId)
    );

    if (sessionGroupKeys.some((keys) => keys === undefined || keys.size === 0)) {
        return [];
    }

    const [smallest, ...rest] = sessionGroupKeys
        .toSorted((left, right) => (left?.size ?? 0) - (right?.size ?? 0)) as [
            Set<string>,
            ...Set<string>[],
        ];
    const snapshots: GroupSnapshot[] = [];

    for (const groupKey of smallest) {
        if (!rest.every((keys) => keys.has(groupKey))) {
            continue;
        }

        const snapshot = repository.read(groupKey);
        if (!snapshot) {
            removeGroupKeyFromSessionIndex(index, groupKey);
            continue;
        }

        if (groupSnapshotHasSessionIds(snapshot, uniqueSessionIds)) {
            snapshots.push(snapshot);
        }
    }

    return snapshots;
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
    const decision = writeGroupStateSnapshot(snapshot, manager);
    return decision === 'inserted' || decision === 'advanced';
}

export function observeGroupStateSnapshot(
    snapshot: GroupSnapshot,
    manager?: RepositoryManager,
): StateSnapshotObservation {
    return toStateSnapshotObservation(
        writeGroupStateSnapshot(snapshot, manager),
    );
}

function writeGroupStateSnapshot(
    snapshot: GroupSnapshot,
    manager?: RepositoryManager,
): StateSnapshotRevisionDecision {
    const repository = requireGroupStateSnapshotRepository(manager);
    const repositoryKey = toGroupStateSnapshotRepositoryKey(snapshot.group);
    const current = repository.read(repositoryKey);
    const previousForIndex = repository.peek(repositoryKey);
    const decision = decideStateSnapshotRevision({
        entity: 'Group',
        current,
        incoming: snapshot,
        stateRevisionOf: (value) => value.stateRevision,
        equals: jsonEquals,
    });

    if (decision === 'inserted' || decision === 'advanced') {
        repository.set(repositoryKey, snapshot);
        replaceGroupSnapshotInSessionIndex(
            repository,
            repositoryKey,
            previousForIndex,
            snapshot,
        );
        if (decision === 'advanced') {
            console.log(`Received updated group snapshot: ${snapshot.group.groupId}`);
        }
        return decision;
    }

    return decision;
}

export function removeGroupStateSnapshotByRef(
    ref: GroupRef,
    manager?: RepositoryManager,
): boolean {
    const repository = requireGroupStateSnapshotRepository(manager);
    const repositoryKey = toGroupStateSnapshotRepositoryKey(ref);
    const previous = repository.peek(repositoryKey);
    const removed = repository.delete(repositoryKey);
    if (removed) {
        removeGroupSnapshotFromSessionIndex(
            groupSessionIndexForRepository(repository),
            repositoryKey,
            previous,
        );
    }
    return removed;
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

function groupSessionIndexForRepository(
    repository: ObservableLatestRepository<string, GroupSnapshot>,
): GroupSessionIndex {
    let index = groupSessionIndexes.get(repository);
    if (!index) {
        index = buildGroupSessionIndex(repository);
        groupSessionIndexes.set(repository, index);
    }
    return index;
}

function buildGroupSessionIndex(
    repository: ObservableLatestRepository<string, GroupSnapshot>,
): GroupSessionIndex {
    const index: GroupSessionIndex = new Map();
    for (const [key, entry] of repository.entriesView()) {
        const snapshot = entry.read();
        if (snapshot) {
            addGroupSnapshotToSessionIndex(index, key, snapshot);
        }
    }
    return index;
}

function replaceGroupSnapshotInSessionIndex(
    repository: ObservableLatestRepository<string, GroupSnapshot>,
    key: string,
    previous: GroupSnapshot | undefined,
    next: GroupSnapshot,
): void {
    const index = groupSessionIndexForRepository(repository);
    removeGroupSnapshotFromSessionIndex(index, key, previous);
    addGroupSnapshotToSessionIndex(index, key, next);
}

function addGroupSnapshotToSessionIndex(
    index: GroupSessionIndex,
    key: string,
    snapshot: GroupSnapshot,
): void {
    for (const session of snapshot.activeSessions) {
        let groupKeys = index.get(session.sessionId);
        if (!groupKeys) {
            groupKeys = new Set();
            index.set(session.sessionId, groupKeys);
        }
        groupKeys.add(key);
    }
}

function removeGroupSnapshotFromSessionIndex(
    index: GroupSessionIndex,
    key: string,
    snapshot: GroupSnapshot | undefined,
): void {
    if (!snapshot) {
        removeGroupKeyFromSessionIndex(index, key);
        return;
    }

    for (const session of snapshot.activeSessions) {
        const groupKeys = index.get(session.sessionId);
        if (!groupKeys) {
            continue;
        }

        groupKeys.delete(key);
        if (groupKeys.size === 0) {
            index.delete(session.sessionId);
        }
    }
}

function removeGroupKeyFromSessionIndex(
    index: GroupSessionIndex,
    key: string,
): void {
    for (const [sessionId, groupKeys] of index) {
        groupKeys.delete(key);
        if (groupKeys.size === 0) {
            index.delete(sessionId);
        }
    }
}

function groupSnapshotHasSessionIds(
    snapshot: GroupSnapshot,
    sessionIds: readonly string[],
): boolean {
    const activeSessionIds = new Set(
        snapshot.activeSessions.map((session) => session.sessionId),
    );
    return sessionIds.every((sessionId) => activeSessionIds.has(sessionId));
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
