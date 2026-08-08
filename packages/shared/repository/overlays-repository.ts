import { OverlayInfo } from '@shared/api/api-config.ts';
import {
    isOverlayForGroupRef,
    toScopedOverlayId,
} from '@shared/api/api-type-utils.ts';
import type { GroupRef } from '@shared/api/group-types.ts';
import {
    type AnyGroupPresence,
    compareGroupCausalRevision,
    readGroupCausalRevision,
    readGroupCreatedAtEpochMs,
    readGroupCreatedByPrincipalId,
    readGroupDisplayName,
    readGroupMemberSessionIds,
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

export type OverlayAdoptionOutcome =
    | 'initial-set'
    | 'adopted'
    | 'equal'
    | 'dominated-dropped'
    | 'incomparable-conflict';

export type OverlayAdoptionDiagnosticsEvent = Readonly<{
    overlayId: string;
    outcome: OverlayAdoptionOutcome;
}>;

export type OverlayAdoptionDiagnosticsSink = (
    event: OverlayAdoptionDiagnosticsEvent,
) => void;

interface MutableOverlayAdoptionDiagnostics {
    initialSetCount: number;
    adoptedCount: number;
    equalCount: number;
    dominatedDroppedCount: number;
    incomparableConflictCount: number;
}

export type RallarOverlayAdoptionDiagnostics = Readonly<MutableOverlayAdoptionDiagnostics>;

// One process-wide sink and counter object keep the adoption surface additive and opt-in.
let adoptionDiagnosticsSink: OverlayAdoptionDiagnosticsSink | undefined;
const adoptionCounters: MutableOverlayAdoptionDiagnostics = emptyOverlayAdoptionDiagnostics();

export function setOverlayAdoptionDiagnosticsSink(
    sink: OverlayAdoptionDiagnosticsSink | undefined,
): void {
    adoptionDiagnosticsSink = sink;
}

export function readOverlayAdoptionDiagnostics(): RallarOverlayAdoptionDiagnostics {
    return { ...adoptionCounters };
}

export function resetOverlayAdoptionDiagnostics(): void {
    Object.assign(adoptionCounters, emptyOverlayAdoptionDiagnostics());
}

function emptyOverlayAdoptionDiagnostics(): MutableOverlayAdoptionDiagnostics {
    return {
        initialSetCount: 0,
        adoptedCount: 0,
        equalCount: 0,
        dominatedDroppedCount: 0,
        incomparableConflictCount: 0,
    };
}

function emitOverlayAdoption(overlayId: string, outcome: OverlayAdoptionOutcome): void {
    if (outcome === 'initial-set') {
        adoptionCounters.initialSetCount += 1;
    } else if (outcome === 'adopted') {
        adoptionCounters.adoptedCount += 1;
    } else if (outcome === 'equal') {
        adoptionCounters.equalCount += 1;
    } else if (outcome === 'dominated-dropped') {
        adoptionCounters.dominatedDroppedCount += 1;
    } else {
        adoptionCounters.incomparableConflictCount += 1;
    }
    try {
        adoptionDiagnosticsSink?.({ overlayId, outcome });
    } catch {
        // Recording must never affect overlay adoption behavior.
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
                compareOverlayInfoTuple(left, right) === 'equal' &&
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
        emitOverlayAdoption(id, 'initial-set');
        repository.set(id, overlay);
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
    left: Pick<OverlayInfo, 'sourceGroupStateCausalRevision' | 'overlayVersion'>,
    right: Pick<OverlayInfo, 'sourceGroupStateCausalRevision' | 'overlayVersion'>,
): 'equal' | 'dominates' | 'dominated' | 'incomparable' {
    const sourceOrder = compareGroupCausalRevision(
        left.sourceGroupStateCausalRevision,
        right.sourceGroupStateCausalRevision,
    );
    if (sourceOrder !== 'equal') {
        return sourceOrder;
    }
    if (left.overlayVersion === right.overlayVersion) return 'equal';
    return left.overlayVersion > right.overlayVersion
        ? 'dominates'
        : 'dominated';
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
        sourceGroupStateCausalRevision: readGroupCausalRevision(group),
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
        updatedAtEpochMs: readGroupUpdatedAtEpochMs(group),
    };
}
