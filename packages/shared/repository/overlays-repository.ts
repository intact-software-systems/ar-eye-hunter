import type { OverlayInfo } from '@shared/api/api-config.ts';
import { toScopedOverlayId } from '@shared/api/api-type-utils.ts';
import { compareGroupCausalRevision } from '@shared/api/group-client-views.ts';
import {
    isSameGroupLayoutIdentity,
    type GroupLayoutIdentity
} from '@shared/api/group-lifecycle/group-layout-identity.ts';
import type { GroupRef } from '@shared/api/group-types.ts';
import {
    configureObservableLatestRepository,
    newObservableLatestRepositoryToken,
    readObservableLatestRepositoryValue,
    requireObservableLatestRepository
} from '@shared/cache/LatestRepositoryHelpers.ts';
import {
    type ObservableLatestRepository,
    type ObservableLatestRepositoryOptions
} from '@shared/cache/ObservableLatestRepository.ts';
import {
    type ObservableKeyedValueEvent,
    type ObservableValueEventType,
    type ReadableKeyedValues
} from '@shared/cache/RepositoryInterfaces.ts';
import type { RepositoryManager } from '@shared/cache/RepositoryManager.ts';
import type { RepositoryToken } from '@shared/cache/RepositoryToken.ts';

import { emitOverlayAdoption, type OverlayAdoptionOutcome } from './overlay-adoption-diagnostics.ts';

export type OverlayRepositoryOptions =
    & Omit<ObservableLatestRepositoryOptions<string, OverlayInfo>, 'ttlMs' | 'equals'>
    & { ttlMs: number; };

export interface OverlayRepositoryCacheConfiguration {
    readonly plannedOverlays: OverlayRepositoryOptions;
    readonly acceptedOverlays: OverlayRepositoryOptions;
}

export interface OverlayRepositoryChange {
    readonly kind: ObservableValueEventType;
    readonly overlayId: string;
    readonly overlay?: OverlayInfo;
    readonly previous?: OverlayInfo;
    readonly version: number;
    readonly previousVersion?: number;
    readonly manager?: RepositoryManager;
}

export type OverlayRepositoryChangeListener = (
    change: OverlayRepositoryChange
) => void | Promise<void>;

interface SetOverlayInput {
    readonly token: RepositoryToken<ObservableLatestRepository<string, OverlayInfo>>;
    readonly overlayId: string;
    readonly overlay: OverlayInfo;
    readonly manager?: RepositoryManager;
}

interface ReconcileAcceptedOverlayIdentityInput {
    readonly overlayId: string;
    readonly acceptedIdentity: GroupLayoutIdentity | undefined;
    readonly manager?: RepositoryManager;
}

interface RemoveOverlayIfUnchangedInput {
    readonly token: RepositoryToken<ObservableLatestRepository<string, OverlayInfo>>;
    readonly overlayId: string;
    readonly observedOverlay: OverlayInfo | undefined;
    readonly manager?: RepositoryManager;
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

const plannedOverlayRepositoryToken = newObservableLatestRepositoryToken<string, OverlayInfo>(
    'shared.repository.planned-overlays',
    'Planned overlay repository is not configured'
);

const acceptedOverlayRepositoryToken = newObservableLatestRepositoryToken<string, OverlayInfo>(
    'shared.repository.accepted-overlays',
    'Accepted overlay repository is not configured'
);

export function configureOverlayRepositories(
    config: OverlayRepositoryCacheConfiguration,
    manager?: RepositoryManager
): void {
    configureRoleOverlayRepository(
        plannedOverlayRepositoryToken,
        config.plannedOverlays,
        manager
    );
    configureRoleOverlayRepository(
        acceptedOverlayRepositoryToken,
        config.acceptedOverlays,
        manager
    );
}

export function onPlannedOverlayChange(
    listener: OverlayRepositoryChangeListener,
    manager?: RepositoryManager
): () => void {
    return onRoleOverlayChange(plannedOverlayRepositoryToken, listener, manager);
}

export function onAcceptedOverlayChange(
    listener: OverlayRepositoryChangeListener,
    manager?: RepositoryManager
): () => void {
    return onRoleOverlayChange(acceptedOverlayRepositoryToken, listener, manager);
}

export async function waitForPlannedOverlayChangesIdle(
    manager?: RepositoryManager
): Promise<void> {
    await requireRoleOverlayRepository(plannedOverlayRepositoryToken, manager).whenIdle();
}

export async function waitForAcceptedOverlayChangesIdle(
    manager?: RepositoryManager
): Promise<void> {
    await requireRoleOverlayRepository(acceptedOverlayRepositoryToken, manager).whenIdle();
}

export function readablePlannedOverlayCache(
    manager?: RepositoryManager
): ReadableKeyedValues<string, OverlayInfo> {
    return requireRoleOverlayRepository(plannedOverlayRepositoryToken, manager).readable();
}

export function readableAcceptedOverlayCache(
    manager?: RepositoryManager
): ReadableKeyedValues<string, OverlayInfo> {
    return requireRoleOverlayRepository(acceptedOverlayRepositoryToken, manager).readable();
}

export function updatePlannedOverlayNextHopSessionIds(
    overlayId: string,
    nextHopSessionIds: readonly string[],
    manager?: RepositoryManager
): void {
    const overlay = findPlannedOverlayById(overlayId, manager);
    if (overlay === undefined) {
        return;
    }

    setPlannedOverlayById(overlayId, {
        ...overlay,
        nextHopSessionIds: [...nextHopSessionIds],
        overlayVersion: overlay.overlayVersion + 1,
        updatedAtEpochMs: Math.max(Date.now(), overlay.updatedAtEpochMs + 1)
    }, manager);
}

export function hasPlannedServerOverlayRecordByGroupRef(
    groupRef: GroupRef,
    manager?: RepositoryManager
): boolean {
    return readOverlayRecordById(
        plannedOverlayRepositoryToken,
        toScopedOverlayId(groupRef),
        manager
    )?.provenance === 'server';
}

export function hasAcceptedServerOverlayRecordByGroupRef(
    groupRef: GroupRef,
    manager?: RepositoryManager
): boolean {
    return readOverlayRecordById(
        acceptedOverlayRepositoryToken,
        toScopedOverlayId(groupRef),
        manager
    )?.provenance === 'server';
}

export function findPlannedOverlayById(
    overlayId: string,
    manager?: RepositoryManager
): OverlayInfo | undefined {
    return findRoleOverlayById(plannedOverlayRepositoryToken, overlayId, manager);
}

export function findAcceptedOverlayById(
    overlayId: string,
    manager?: RepositoryManager
): OverlayInfo | undefined {
    return findRoleOverlayById(acceptedOverlayRepositoryToken, overlayId, manager);
}

export function setPlannedOverlayById(
    overlayId: string,
    overlay: OverlayInfo,
    manager?: RepositoryManager
): OverlayAdoptionOutcome {
    return setOverlay({
        token: plannedOverlayRepositoryToken,
        overlayId,
        overlay,
        manager
    });
}

export function setAcceptedOverlayById(
    overlayId: string,
    overlay: OverlayInfo,
    manager?: RepositoryManager
): OverlayAdoptionOutcome {
    return setOverlay({
        token: acceptedOverlayRepositoryToken,
        overlayId,
        overlay,
        manager
    });
}

export function setCurrentPlannedServerOverlayById(
    overlayId: string,
    overlay: OverlayInfo,
    manager?: RepositoryManager
): OverlayAdoptionOutcome {
    return setCurrentServerOverlay({
        token: plannedOverlayRepositoryToken,
        overlayId,
        overlay,
        manager
    });
}

export function setCurrentAcceptedServerOverlayById(
    overlayId: string,
    overlay: OverlayInfo,
    manager?: RepositoryManager
): OverlayAdoptionOutcome {
    return setCurrentServerOverlay({
        token: acceptedOverlayRepositoryToken,
        overlayId,
        overlay,
        manager
    });
}

export function removePlannedOverlayByGroupRef(
    groupRef: GroupRef,
    manager?: RepositoryManager
): boolean {
    return removePlannedOverlayById(toScopedOverlayId(groupRef), manager);
}

export function removeAcceptedOverlayByGroupRef(
    groupRef: GroupRef,
    manager?: RepositoryManager
): boolean {
    return removeAcceptedOverlayById(toScopedOverlayId(groupRef), manager);
}

export function removePlannedOverlayById(
    overlayId: string,
    manager?: RepositoryManager
): boolean {
    return requireRoleOverlayRepository(plannedOverlayRepositoryToken, manager).delete(overlayId);
}

export function removeAcceptedOverlayById(
    overlayId: string,
    manager?: RepositoryManager
): boolean {
    return requireRoleOverlayRepository(acceptedOverlayRepositoryToken, manager).delete(overlayId);
}

export function removePlannedOverlayByIdIfUnchanged(
    overlayId: string,
    observedOverlay: OverlayInfo | undefined,
    manager?: RepositoryManager
): boolean {
    return removeRoleOverlayByIdIfUnchanged({
        token: plannedOverlayRepositoryToken,
        overlayId,
        observedOverlay,
        manager
    });
}

export function removeAcceptedOverlayByIdIfUnchanged(
    overlayId: string,
    observedOverlay: OverlayInfo | undefined,
    manager?: RepositoryManager
): boolean {
    return removeRoleOverlayByIdIfUnchanged({
        token: acceptedOverlayRepositoryToken,
        overlayId,
        observedOverlay,
        manager
    });
}

export function removePlannedOverlayByIdIfIdentity(
    overlayId: string,
    identity: GroupLayoutIdentity,
    manager?: RepositoryManager
): boolean {
    const planned = readOverlayRecordById(plannedOverlayRepositoryToken, overlayId, manager);
    return planned !== undefined && isOverlayIdentity(planned, identity)
        ? removePlannedOverlayById(overlayId, manager)
        : false;
}

export function reconcileAcceptedOverlayIdentity(
    input: ReconcileAcceptedOverlayIdentityInput
): boolean {
    let changed = removeMismatchedAcceptedOverlay(input);
    if (input.acceptedIdentity === undefined) {
        return changed;
    }

    const planned = readOverlayRecordById(
        plannedOverlayRepositoryToken,
        input.overlayId,
        input.manager
    );
    if (
        planned?.provenance !== 'server' ||
        !isOverlayIdentity(planned, input.acceptedIdentity)
    ) {
        return changed;
    }

    const outcome = setCurrentAcceptedServerOverlayById(
        input.overlayId,
        planned,
        input.manager
    );
    changed = didOverlayAdoptionChange(outcome) || changed;
    changed = removePlannedOverlayById(input.overlayId, input.manager) || changed;
    return changed;
}

export function didOverlayAdoptionChange(outcome: OverlayAdoptionOutcome): boolean {
    return outcome === 'initial-set' ||
        outcome === 'adopted' ||
        outcome === 'server-superseded-bootstrap';
}

function compareOverlayInfoTuple(
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

function configureRoleOverlayRepository(
    token: RepositoryToken<ObservableLatestRepository<string, OverlayInfo>>,
    options: OverlayRepositoryOptions,
    manager?: RepositoryManager
): ObservableLatestRepository<string, OverlayInfo> {
    return configureObservableLatestRepository(
        token,
        {
            ...options,
            equals: (left, right) =>
                compareOverlayInfoTuple(left, right) === 'equal' &&
                JSON.stringify(left) === JSON.stringify(right)
        },
        manager
    );
}

function onRoleOverlayChange(
    token: RepositoryToken<ObservableLatestRepository<string, OverlayInfo>>,
    listener: OverlayRepositoryChangeListener,
    manager?: RepositoryManager
): () => void {
    const subscription = requireRoleOverlayRepository(token, manager)
        .onChangeDo(async (event) => {
            await listener(toOverlayRepositoryChange(event, manager));
        });

    return () => {
        subscription.unsubscribe();
    };
}

function requireRoleOverlayRepository(
    token: RepositoryToken<ObservableLatestRepository<string, OverlayInfo>>,
    manager?: RepositoryManager
): ObservableLatestRepository<string, OverlayInfo> {
    return requireObservableLatestRepository(token, manager);
}

function findRoleOverlayById(
    token: RepositoryToken<ObservableLatestRepository<string, OverlayInfo>>,
    overlayId: string,
    manager?: RepositoryManager
): OverlayInfo | undefined {
    const overlay = readOverlayRecordById(token, overlayId, manager);
    return overlay?.state === 'removed' ? undefined : overlay;
}

function removeRoleOverlayByIdIfUnchanged(
    input: RemoveOverlayIfUnchangedInput
): boolean {
    if (
        input.observedOverlay === undefined ||
        readOverlayRecordById(input.token, input.overlayId, input.manager) !== input.observedOverlay
    ) {
        return false;
    }

    return requireRoleOverlayRepository(input.token, input.manager).delete(input.overlayId);
}

function readOverlayRecordById(
    token: RepositoryToken<ObservableLatestRepository<string, OverlayInfo>>,
    overlayId: string,
    manager?: RepositoryManager
): OverlayInfo | undefined {
    return readObservableLatestRepositoryValue(token, overlayId, manager);
}

function setOverlay(input: SetOverlayInput): OverlayAdoptionOutcome {
    const repository = requireRoleOverlayRepository(input.token, input.manager);
    const current = repository.read(input.overlayId);
    if (!current) {
        return adoptOverlay(input, repository, 'initial-set');
    }

    if (input.overlay.provenance === 'server' && current.provenance === 'bootstrap') {
        return adoptOverlay(input, repository, 'server-superseded-bootstrap');
    }
    if (input.overlay.provenance === 'bootstrap' && current.provenance === 'server') {
        return reportOverlayDrop(input.overlayId, 'bootstrap-dropped-over-server');
    }

    const comparison = compareOverlayInfoTuple(input.overlay, current);
    if (comparison === 'dominates') {
        console.log(`Received updated overlay details: ${JSON.stringify(input.overlay)}`);
        return adoptOverlay(input, repository, 'adopted');
    }
    if (comparison === 'equal') {
        return JSON.stringify(input.overlay) === JSON.stringify(current)
            ? reportOverlayDrop(input.overlayId, 'equal')
            : reportOverlayDrop(input.overlayId, 'incomparable-conflict');
    }
    if (comparison === 'incomparable') {
        return reportOverlayDrop(input.overlayId, 'incomparable-conflict');
    }

    console.log(
        'Received stale overlay data: ' +
            JSON.stringify(input.overlay) +
            ' vs ' +
            JSON.stringify(current)
    );
    return reportOverlayDrop(input.overlayId, 'dominated-dropped');
}

function setCurrentServerOverlay(input: SetOverlayInput): OverlayAdoptionOutcome {
    if (input.overlay.provenance !== 'server') {
        throw new TypeError('Current topology repair must contain a server overlay');
    }
    const repository = requireRoleOverlayRepository(input.token, input.manager);
    const current = repository.read(input.overlayId);
    if (
        current?.provenance === 'server' &&
        compareOverlayInfoTuple(input.overlay, current) === 'incomparable'
    ) {
        return adoptOverlay(input, repository, 'adopted');
    }

    return setOverlay(input);
}

function adoptOverlay(
    input: SetOverlayInput,
    repository: ObservableLatestRepository<string, OverlayInfo>,
    outcome: OverlayAdoptionOutcome
): OverlayAdoptionOutcome {
    emitOverlayAdoption(input.overlayId, outcome);
    repository.set(input.overlayId, input.overlay);
    return outcome;
}

function reportOverlayDrop(
    overlayId: string,
    outcome: OverlayAdoptionOutcome
): OverlayAdoptionOutcome {
    emitOverlayAdoption(overlayId, outcome);
    return outcome;
}

function removeMismatchedAcceptedOverlay(
    input: ReconcileAcceptedOverlayIdentityInput
): boolean {
    const accepted = readOverlayRecordById(
        acceptedOverlayRepositoryToken,
        input.overlayId,
        input.manager
    );
    if (
        accepted === undefined ||
        (input.acceptedIdentity !== undefined && isOverlayIdentity(accepted, input.acceptedIdentity))
    ) {
        return false;
    }

    return removeAcceptedOverlayById(input.overlayId, input.manager);
}

function isOverlayIdentity(
    overlay: OverlayInfo,
    identity: GroupLayoutIdentity
): boolean {
    return isSameGroupLayoutIdentity(
        {
            groupRevision: overlay.sourceGroupStateCausalRevision.groupRevision,
            presenceRevision: overlay.sourceGroupStateCausalRevision.presenceRevision,
            version: overlay.overlayVersion,
            state: overlay.state
        },
        identity
    );
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
