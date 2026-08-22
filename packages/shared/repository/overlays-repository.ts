import { OverlayInfo } from '@shared/api/api-config.ts';
import { isOverlayForGroupRef, toScopedOverlayId } from '@shared/api/api-type-utils.ts';
import {
    compareGroupCausalRevision,
    readGroupCausalRevision,
    readGroupCreatedAtEpochMs,
    readGroupCreatedByPrincipalId,
    readGroupDisplayName,
    readGroupMemberSessionIds,
    readGroupUpdatedAtEpochMs,
    readGroupVersion,
    type AnyGroupPresence
} from '@shared/api/group-client-views.ts';
import type { GroupRef } from '@shared/api/group-types.ts';
import {
    configureObservableLatestRepository,
    newObservableLatestRepositoryToken,
    readAllObservableLatestRepository,
    readObservableLatestRepositoryValue,
    requireObservableLatestRepository
} from '@shared/cache/LatestRepositoryHelpers.ts';
import {
    ObservableLatestRepository,
    type ObservableLatestRepositoryOptions
} from '@shared/cache/ObservableLatestRepository.ts';
import {
    ObservableValueEventType,
    type ObservableKeyedValueEvent,
    type ReadableKeyedValues
} from '@shared/cache/RepositoryInterfaces.ts';
import type { RepositoryManager } from '@shared/cache/RepositoryManager.ts';
import { emitOverlayAdoption } from './overlay-adoption-diagnostics.ts';

export type OverlayRepositoryOptions =
    & Omit<ObservableLatestRepositoryOptions<string, OverlayInfo>, 'ttlMs' | 'equals'>
    & { ttlMs: number; };

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
    change: OverlayRepositoryChange
) => void | Promise<void>;

export class OverlayRevisionConflictError extends Error {
    readonly overlayId: string;

    constructor(overlayId: string) {
        super(`Overlay revision conflict: ${overlayId}`);
        this.overlayId = overlayId;
        this.name = 'OverlayRevisionConflictError';
    }
}

export {
    type OverlayAdoptionDiagnosticsEvent,
    type OverlayAdoptionDiagnosticsSink,
    type OverlayAdoptionOutcome,
    type RallarOverlayAdoptionDiagnostics,
    readOverlayAdoptionDiagnostics,
    resetOverlayAdoptionDiagnostics,
    setOverlayAdoptionDiagnosticsSink
} from './overlay-adoption-diagnostics.ts';

export const overlayRepositoryToken = newObservableLatestRepositoryToken<string, OverlayInfo>(
    'shared.repository.overlays',
    'Overlay repository is not configured'
);

export function configureOverlayRepository(
    options: OverlayRepositoryOptions,
    manager?: RepositoryManager
): ObservableLatestRepository<string, OverlayInfo> {
    return configureObservableLatestRepository(
        overlayRepositoryToken,
        {
            ...options,
            equals: (left, right) =>
                compareOverlayInfoTuple(left, right) === 'equal' &&
                JSON.stringify(left) === JSON.stringify(right)
        },
        manager
    );
}

export function onOverlayChange(
    listener: OverlayRepositoryChangeListener,
    manager?: RepositoryManager
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
    manager?: RepositoryManager
): Promise<void> {
    await requireOverlayRepository(manager).whenIdle();
}

function requireOverlayRepository(
    manager?: RepositoryManager
): ObservableLatestRepository<string, OverlayInfo> {
    return requireObservableLatestRepository(overlayRepositoryToken, manager);
}

export function readableOverlayCache(
    manager?: RepositoryManager
): ReadableKeyedValues<string, OverlayInfo> {
    return requireOverlayRepository(manager).readable();
}

export function createAndSetStarOverlays(
    groups: readonly AnyGroupPresence[],
    manager?: RepositoryManager
): void {
    for (const group of groups) {
        const overlay = toStarOverlay(group);
        setOverlayById(overlay.overlayId, overlay, manager);
    }
}

export function updateNextHopSessionIds(
    overlayId: string,
    nextHopSessionIds: string[],
    manager?: RepositoryManager
): OverlayInfo | undefined {
    const overlay: OverlayInfo | undefined = findOverlayById(overlayId, manager);
    if (overlay === undefined) {
        return undefined;
    }

    setOverlayById(overlayId, {
        ...overlay,
        nextHopSessionIds: nextHopSessionIds,
        overlayVersion: overlay.overlayVersion + 1,
        updatedAtEpochMs: Math.max(Date.now(), overlay.updatedAtEpochMs + 1)
    }, manager);

    return overlay;
}

export function findOverlayByGroupRef(
    groupRef: GroupRef,
    manager?: RepositoryManager
): OverlayInfo | undefined {
    return findOverlayById(toScopedOverlayId(groupRef), manager);
}

export function setOverlayByGroupRef(
    groupRef: GroupRef,
    overlay: OverlayInfo,
    manager?: RepositoryManager
): void {
    setOverlayById(toScopedOverlayId(groupRef), overlay, manager);
}

export function removeOverlayByGroupRef(
    groupRef: GroupRef,
    manager?: RepositoryManager
): boolean {
    return removeOverlayById(toScopedOverlayId(groupRef), manager);
}

export function removeLegacyOverlayByGroupIdIfMatches(
    groupRef: GroupRef,
    manager?: RepositoryManager
): boolean {
    const overlay = findOverlayById(groupRef.groupId, manager);
    if (!overlay || !isOverlayForGroupRef(overlay, groupRef)) {
        return false;
    }

    return removeOverlayById(groupRef.groupId, manager);
}

export function removeOverlayById(
    overlayId: string,
    manager?: RepositoryManager
): boolean {
    return requireOverlayRepository(manager).delete(overlayId);
}

export function findOverlayById(
    id: string,
    manager?: RepositoryManager
): OverlayInfo | undefined {
    const overlay = readObservableLatestRepositoryValue(
        overlayRepositoryToken,
        id,
        manager
    );
    return overlay?.state === 'removed' ? undefined : overlay;
}

export function setOverlayById(
    id: string,
    overlay: OverlayInfo,
    manager?: RepositoryManager
): void {
    const repository = requireOverlayRepository(manager);
    const current = repository.read(id);
    if (!current) {
        emitOverlayAdoption(id, 'initial-set');
        repository.set(id, overlay);
        return;
    }

    // Server overlays are authoritative over bootstrap overlays regardless of
    // the causal tuple: a bootstrap star restamped from a newer group revision
    // must never displace a server topology (scenario S5), and a server
    // overlay planned against an older revision must still be adopted.
    if (overlay.provenance === 'server' && current.provenance === 'bootstrap') {
        emitOverlayAdoption(id, 'server-superseded-bootstrap');
        repository.set(id, overlay);
        return;
    }

    if (overlay.provenance === 'bootstrap' && current.provenance === 'server') {
        emitOverlayAdoption(id, 'bootstrap-dropped-over-server');
        return;
    }

    const comparison = compareOverlayInfoTuple(overlay, current);
    if (comparison === 'dominates') {
        emitOverlayAdoption(id, 'adopted');
        console.log(`Received updated overlay details: ${JSON.stringify(overlay)}`);
        repository.set(id, overlay);
        return;
    }

    if (comparison === 'equal') {
        if (JSON.stringify(overlay) === JSON.stringify(current)) {
            emitOverlayAdoption(id, 'equal');
            return;
        }
        emitOverlayAdoption(id, 'incomparable-conflict');
        throw new OverlayRevisionConflictError(id);
    }

    if (comparison === 'incomparable') {
        emitOverlayAdoption(id, 'incomparable-conflict');
        throw new OverlayRevisionConflictError(id);
    }

    emitOverlayAdoption(id, 'dominated-dropped');
    console.log(
        'Received stale overlay data: ' +
            JSON.stringify(overlay) +
            ' vs ' +
            JSON.stringify(current)
    );
}

export function setCurrentServerOverlayById(
    id: string,
    overlay: OverlayInfo,
    manager?: RepositoryManager
): void {
    if (overlay.provenance !== 'server') {
        throw new TypeError('Current topology repair must contain a server overlay');
    }
    const repository = requireOverlayRepository(manager);
    const current = repository.read(id);
    if (
        !current ||
        current.provenance === 'bootstrap' ||
        compareOverlayInfoTuple(overlay, current) !== 'incomparable'
    ) {
        setOverlayById(id, overlay, manager);
        return;
    }

    // The server emits this path only from a fresh durable current-state read.
    // It deliberately supersedes an incomparable historical server publication.
    emitOverlayAdoption(id, 'adopted');
    repository.set(id, overlay);
}

export function getAllOverlays(
    manager?: RepositoryManager
): OverlayInfo[] {
    return readAllObservableLatestRepository(overlayRepositoryToken, manager)
        .filter((overlay) => overlay.state !== 'removed');
}

export function compareOverlayInfoTuple(
    left: Pick<OverlayInfo, 'sourceGroupStateCausalRevision' | 'overlayVersion'>,
    right: Pick<OverlayInfo, 'sourceGroupStateCausalRevision' | 'overlayVersion'>
): 'equal' | 'dominates' | 'dominated' | 'incomparable' {
    const sourceOrder = compareGroupCausalRevision(
        left.sourceGroupStateCausalRevision,
        right.sourceGroupStateCausalRevision
    );
    if (sourceOrder !== 'equal') {
        return sourceOrder;
    }
    if (left.overlayVersion === right.overlayVersion) {
        return 'equal';
    }
    return left.overlayVersion > right.overlayVersion
        ? 'dominates'
        : 'dominated';
}

function toOverlayRepositoryChange(
    event: ObservableKeyedValueEvent<string, OverlayInfo>,
    manager?: RepositoryManager
): OverlayRepositoryChange {
    return {
        kind: event.type,
        overlayId: event.key,
        overlay: event.value,
        previous: event.previous,
        version: event.value?.overlayVersion ?? event.previous?.overlayVersion ?? 0,
        previousVersion: event.previous?.overlayVersion,
        manager
    };
}

function toStarOverlay(group: AnyGroupPresence): OverlayInfo {
    return {
        sourceGroupStateCausalRevision: readGroupCausalRevision(group),
        provenance: 'bootstrap',
        state: 'active',
        name: readGroupDisplayName(group),
        overlayId: toScopedOverlayId(group.group),
        groupRef: group.group,
        topology: 'star',
        createdByClientId: readGroupCreatedByPrincipalId(group),
        createdAtEpochMs: readGroupCreatedAtEpochMs(group),
        nextHopSessionIds: readGroupMemberSessionIds(group),
        degreeLimit: Math.max(1, readGroupMemberSessionIds(group).length - 1),
        overlayVersion: readGroupVersion(group),
        updatedAtEpochMs: readGroupUpdatedAtEpochMs(group)
    };
}
