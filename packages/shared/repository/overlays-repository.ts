import {
    type OverlayInfo,
    type OverlayProvenance,
} from '@shared/api/api-config.ts';
import {
    isOverlayForGroupRef,
    toScopedOverlayId,
} from '@shared/api/api-type-utils.ts';
import type { GroupRef } from '@shared/api/group-types.ts';
import {
    type AnyGroupPresence,
    readGroupCreatedAtEpochMs,
    readGroupCreatedByPrincipalId,
    readGroupDisplayName,
    readGroupMemberSessionIds,
    readGroupStateRevision,
    readGroupUpdatedAtEpochMs,
    readGroupVersion,
} from '@shared/api/group-client-views.ts';
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

export type OverlayRepositoryOptions =
    & Omit<
        ObservableLatestRepositoryOptions<string, OverlayInfo>,
        'ttlMs' | 'equals'
    >
    & { ttlMs: number };

export type OverlayRepositoryChange = Readonly<{
    kind: ObservableValueEventType;
    overlayId: string;
    overlay?: OverlayInfo;
    previous?: OverlayInfo;
    version: number;
    previousVersion?: number;
    manager?: RepositoryManager;
}>;

export type OverlayRepositoryChangeListener = (
    change: OverlayRepositoryChange,
) => void | Promise<void>;

export class OverlayRevisionConflictError extends Error {
    constructor(readonly overlayId: string) {
        super(`Overlay revision conflict: ${overlayId}`);
        this.name = 'OverlayRevisionConflictError';
    }
}

export const overlayRepositoryToken = newObservableLatestRepositoryToken<string, OverlayInfo>(
    'shared.repository.overlays',
    'Overlay repository is not configured',
);

export function configureOverlayRepository(
    options: OverlayRepositoryOptions,
    manager?: RepositoryManager,
): ObservableLatestRepository<string, OverlayInfo> {
    return configureObservableLatestRepository(
        overlayRepositoryToken,
        {
            ...options,
            equals: (left, right) =>
                compareOverlayInfoTuple(left, right) === 0 &&
                JSON.stringify(left) === JSON.stringify(right),
        },
        manager,
    );
}

export function onOverlayChange(
    listener: OverlayRepositoryChangeListener,
    manager?: RepositoryManager,
): () => void {
    const subscription = requireOverlayRepository(manager)
        .onChangeDo(async (event) => {
            await listener(toOverlayRepositoryChange(event, manager));
        });

    return () => {
        subscription.unsubscribe();
    };
}

export async function waitForOverlayChangesIdle(
    manager?: RepositoryManager,
): Promise<void> {
    await requireOverlayRepository(manager).whenIdle();
}

function requireOverlayRepository(
    manager?: RepositoryManager,
): ObservableLatestRepository<string, OverlayInfo> {
    return requireObservableLatestRepository(overlayRepositoryToken, manager);
}

export function readableOverlayCache(
    manager?: RepositoryManager,
): ReadableKeyedValues<
    string,
    OverlayInfo
> {
    return requireOverlayRepository(manager).readable();
}

export function createAndSetStarOverlays(
    groups: readonly AnyGroupPresence[],
    manager?: RepositoryManager,
): void {
    for (const group of groups) {
        const overlay = toStarOverlay(group);
        setOverlayById(overlay.overlayId, overlay, manager);
    }
}

export function updateNextHopSessionIds(
    overlayId: string,
    nextHopSessionIds: string[],
    manager?: RepositoryManager,
): OverlayInfo | undefined {
    const overlay: OverlayInfo | undefined = findOverlayById(overlayId, manager);
    if (overlay === undefined) {
        return undefined;
    }

    setOverlayById(overlayId, {
        ...overlay,
        nextHopSessionIds: nextHopSessionIds,
        overlayVersion: overlay.overlayVersion + 1,
        updatedAtEpochMs: Math.max(Date.now(), overlay.updatedAtEpochMs + 1),
    }, manager);

    return overlay;
}

export function findOverlayByGroupRef(
    groupRef: GroupRef,
    manager?: RepositoryManager,
): OverlayInfo | undefined {
    return findOverlayById(toScopedOverlayId(groupRef), manager);
}

export function setOverlayByGroupRef(
    groupRef: GroupRef,
    overlay: OverlayInfo,
    manager?: RepositoryManager,
): void {
    setOverlayById(toScopedOverlayId(groupRef), overlay, manager);
}

export function removeOverlayByGroupRef(
    groupRef: GroupRef,
    manager?: RepositoryManager,
): boolean {
    return removeOverlayById(toScopedOverlayId(groupRef), manager);
}

export function removeLegacyOverlayByGroupIdIfMatches(
    groupRef: GroupRef,
    manager?: RepositoryManager,
): boolean {
    const overlay = findOverlayById(groupRef.groupId, manager);
    if (!overlay || !isOverlayForGroupRef(overlay, groupRef)) {
        return false;
    }

    return removeOverlayById(groupRef.groupId, manager);
}

export function removeOverlayById(
    overlayId: string,
    manager?: RepositoryManager,
): boolean {
    return requireOverlayRepository(manager).delete(overlayId);
}

export function findOverlayById(
    id: string,
    manager?: RepositoryManager,
): OverlayInfo | undefined {
    const overlay = readObservableLatestRepositoryValue(
        overlayRepositoryToken,
        id,
        manager,
    );
    return overlay?.state === 'removed' ? undefined : overlay;
}

export function setOverlayById(
    id: string,
    overlay: OverlayInfo,
    manager?: RepositoryManager,
): void {
    const repository = requireOverlayRepository(manager);
    const current = repository.read(id);
    if (!current) {
        repository.set(id, overlay);
        return;
    }

    const comparison = compareOverlayInfoTuple(overlay, current);
    if (comparison > 0) {
        console.log(`Received updated overlay details: ${JSON.stringify(overlay)}`);
        repository.set(id, overlay);
        return;
    }

    if (comparison === 0) {
        if (JSON.stringify(overlay) === JSON.stringify(current)) {
            return;
        }
        throw new OverlayRevisionConflictError(id);
    }

    console.log(
        'Received stale overlay data: ' +
        JSON.stringify(overlay) +
        ' vs ' +
        JSON.stringify(current),
    );
}

export function getAllOverlays(
    manager?: RepositoryManager,
): OverlayInfo[] {
    return readAllObservableLatestRepository(overlayRepositoryToken, manager)
        .filter((overlay) => overlay.state !== 'removed');
}

export function compareOverlayInfoTuple(
    left: Pick<
        OverlayInfo,
        'sourceGroupStateRevision' | 'provenance' | 'overlayVersion'
    >,
    right: Pick<
        OverlayInfo,
        'sourceGroupStateRevision' | 'provenance' | 'overlayVersion'
    >,
): number {
    if (left.provenance !== right.provenance) {
        return overlayProvenanceRank(left.provenance) -
            overlayProvenanceRank(right.provenance);
    }
    if (left.sourceGroupStateRevision !== right.sourceGroupStateRevision) {
        return left.sourceGroupStateRevision - right.sourceGroupStateRevision;
    }
    return left.overlayVersion - right.overlayVersion;
}

function overlayProvenanceRank(provenance: OverlayProvenance): number {
    switch (provenance) {
        case 'group-fallback':
            return 0;
        case 'topology-snapshot':
            return 1;
    }
}

function toOverlayRepositoryChange(
    event: ObservableKeyedValueEvent<string, OverlayInfo>,
    manager?: RepositoryManager,
): OverlayRepositoryChange {
    return {
        kind: event.type,
        overlayId: event.key,
        overlay: event.value,
        previous: event.previous,
        version: event.value?.overlayVersion ?? event.previous?.overlayVersion ?? 0,
        previousVersion: event.previous?.overlayVersion,
        manager,
    };
}

function toStarOverlay(group: AnyGroupPresence): OverlayInfo {
    return {
        sourceGroupStateRevision: readGroupStateRevision(group),
        provenance: 'group-fallback',
        state: 'active',
        name: readGroupDisplayName(group),
        overlayId: toScopedOverlayId(group.group),
        groupRef: group.group,
        topology: 'star',
        createdByClientId: readGroupCreatedByPrincipalId(group),
        createdAtEpochMs: readGroupCreatedAtEpochMs(group),
        nextHopSessionIds: readGroupMemberSessionIds(group),
        overlayVersion: readGroupVersion(group),
        updatedAtEpochMs: readGroupUpdatedAtEpochMs(group),
    };
}
