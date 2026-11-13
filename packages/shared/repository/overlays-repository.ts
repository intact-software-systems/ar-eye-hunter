import type { OverlayInfo } from '@shared/api/api-config.ts';
import { toScopedOverlayId } from '@shared/api/api-type-utils.ts';
import { resolveGroupLayoutRole, type GroupLayoutIdentity } from '@shared/api/group-lifecycle/group-layout-identity.ts';
import type { GroupRef } from '@shared/api/group-types.ts';
import {
    configureObservableLatestRepository,
    newObservableLatestRepositoryToken,
    readObservableLatestRepositoryValue,
    requireObservableLatestRepository
} from '@shared/cache/configure-latest-repository.ts';
import { defaultRepositoryManager } from '@shared/cache/defaultRepositoryManager.ts';
import {
    type ObservableLatestRepository,
    type ObservableLatestRepositoryOptions
} from '@shared/cache/observable/observable-latest-repository.ts';
import {
    type ObservableKeyedValueEvent,
    type ObservableValueEventType,
    type ReadableKeyedValues
} from '@shared/cache/RepositoryInterfaces.ts';
import type { RepositoryManager } from '@shared/cache/RepositoryManager.ts';
import { RepositoryToken } from '@shared/cache/RepositoryToken.ts';

import { isRoomLayoutOverlay } from './is-accepted-room-layout-overlay.ts';
import { emitOverlayAdoption, type OverlayAdoptionOutcome } from './overlay-adoption-diagnostics.ts';
import type { OverlayLayoutTransition } from './overlay-layout-transition.ts';
import { isOverlayIdentity, toOverlayLayoutIdentity } from './to-overlay-layout-identity.ts';

export interface OverlayRepositoryOptions
    extends Omit<ObservableLatestRepositoryOptions<string, OverlayInfo>, 'ttlMs' | 'equals'> {
    readonly ttlMs: number | undefined;
}

export interface OverlayRepositoryCacheConfiguration {
    readonly plannedOverlays: OverlayRepositoryOptions;
    readonly acceptedOverlays: OverlayRepositoryOptions;
    readonly nowEpochMs: () => number;
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

interface AcceptedLayoutChange {
    readonly overlayId: string;
    readonly held: OverlayInfo | undefined;
    readonly taker: OverlayInfo;
    readonly nowEpochMs: number;
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

const layoutTransitionRepositoryToken = newObservableLatestRepositoryToken<string, OverlayLayoutTransition>(
    'shared.repository.layout-transitions',
    'Layout transition repository is not configured'
);

const overlayRepositoryClockToken = new RepositoryToken<() => number>(
    'shared.repository.overlay-clock',
    () => {
        throw new Error('Overlay repository clock is not configured');
    }
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
    configureObservableLatestRepository(
        layoutTransitionRepositoryToken,
        {
            ttlMs: config.acceptedOverlays.ttlMs,
            maxEntries: config.acceptedOverlays.maxEntries,
            deleteExpiredIntervalMs: config.acceptedOverlays.deleteExpiredIntervalMs
        },
        manager
    );
    (manager ?? defaultRepositoryManager).set(overlayRepositoryClockToken, config.nowEpochMs);
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
    await requireObservableLatestRepository(plannedOverlayRepositoryToken, manager).whenIdle();
}

export async function waitForAcceptedOverlayChangesIdle(
    manager?: RepositoryManager
): Promise<void> {
    await requireObservableLatestRepository(acceptedOverlayRepositoryToken, manager).whenIdle();
}

export function readablePlannedOverlayCache(
    manager?: RepositoryManager
): ReadableKeyedValues<string, OverlayInfo> {
    return requireObservableLatestRepository(plannedOverlayRepositoryToken, manager).readable();
}

export function readableAcceptedOverlayCache(
    manager?: RepositoryManager
): ReadableKeyedValues<string, OverlayInfo> {
    return requireObservableLatestRepository(acceptedOverlayRepositoryToken, manager).readable();
}

export function readableLayoutTransitionCache(
    manager?: RepositoryManager
): ReadableKeyedValues<string, OverlayLayoutTransition> {
    return requireObservableLatestRepository(layoutTransitionRepositoryToken, manager).readable();
}

export function hasPlannedServerOverlayRecordByGroupRef(
    groupRef: GroupRef,
    manager?: RepositoryManager
): boolean {
    return readObservableLatestRepositoryValue(
        plannedOverlayRepositoryToken,
        toScopedOverlayId(groupRef),
        manager
    )?.provenance === 'server';
}

export function hasAcceptedServerOverlayRecordByGroupRef(
    groupRef: GroupRef,
    manager?: RepositoryManager
): boolean {
    return readObservableLatestRepositoryValue(
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
    return requireObservableLatestRepository(plannedOverlayRepositoryToken, manager).delete(overlayId);
}

export function removeAcceptedOverlayById(
    overlayId: string,
    manager?: RepositoryManager
): boolean {
    const removed = requireObservableLatestRepository(acceptedOverlayRepositoryToken, manager).delete(overlayId);
    if (removed) {
        clearLayoutTransition(overlayId, manager);
    }
    return removed;
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
    const removed = removeRoleOverlayByIdIfUnchanged({
        token: acceptedOverlayRepositoryToken,
        overlayId,
        observedOverlay,
        manager
    });
    if (removed) {
        clearLayoutTransition(overlayId, manager);
    }
    return removed;
}

export function removePlannedOverlayByIdIfIdentity(
    overlayId: string,
    identity: GroupLayoutIdentity,
    manager?: RepositoryManager
): boolean {
    const planned = readObservableLatestRepositoryValue(plannedOverlayRepositoryToken, overlayId, manager);
    return planned !== undefined && isOverlayIdentity(planned, identity)
        ? removePlannedOverlayById(overlayId, manager)
        : false;
}

export function reconcileAcceptedOverlayIdentity(
    input: ReconcileAcceptedOverlayIdentityInput
): boolean {
    const nowEpochMs = readOverlayRepositoryNow(input.manager);
    const held = readObservableLatestRepositoryValue(
        acceptedOverlayRepositoryToken,
        input.overlayId,
        input.manager
    );
    let changed = removeMismatchedAcceptedOverlay(input);
    if (input.acceptedIdentity === undefined) {
        return changed;
    }

    const planned = readObservableLatestRepositoryValue(
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

    const promotion: AcceptedLayoutChange = {
        overlayId: input.overlayId,
        held,
        taker: planned,
        nowEpochMs,
        manager: input.manager
    };
    changed = promotePlannedOverlay(promotion) || changed;
    changed = removePlannedOverlayById(input.overlayId, input.manager) || changed;
    return changed;
}

function promotePlannedOverlay(promotion: AcceptedLayoutChange): boolean {
    const outcome = setCurrentAcceptedServerOverlayById(promotion.overlayId, promotion.taker, promotion.manager);
    if (!didOverlayAdoptionChange(outcome)) {
        return false;
    }
    setLayoutTransitionForAcceptedChange(promotion);
    return true;
}

export function didOverlayAdoptionChange(outcome: OverlayAdoptionOutcome): boolean {
    return outcome === 'initial-set' ||
        outcome === 'adopted' ||
        outcome === 'server-superseded-bootstrap';
}

function compareOverlayInfoIdentity(
    left: OverlayInfo,
    right: OverlayInfo
): 'equal' | 'dominates' | 'dominated' | 'incomparable' {
    const role = resolveGroupLayoutRole({
        publication: toOverlayLayoutIdentity(left),
        accepted: toOverlayLayoutIdentity(right)
    });
    return role === 'accepted'
        ? 'equal'
        : role === 'planned'
        ? 'dominates'
        : role === 'superseded'
        ? 'dominated'
        : 'incomparable';
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
                compareOverlayInfoIdentity(left, right) === 'equal' &&
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
    const subscription = requireObservableLatestRepository(token, manager)
        .onChangeDo(async (event) => {
            await listener(toOverlayRepositoryChange(event, manager));
        });

    return () => {
        subscription.unsubscribe();
    };
}

function findRoleOverlayById(
    token: RepositoryToken<ObservableLatestRepository<string, OverlayInfo>>,
    overlayId: string,
    manager?: RepositoryManager
): OverlayInfo | undefined {
    const overlay = readObservableLatestRepositoryValue(token, overlayId, manager);
    return overlay?.state === 'removed' ? undefined : overlay;
}

function removeRoleOverlayByIdIfUnchanged(
    input: RemoveOverlayIfUnchangedInput
): boolean {
    if (
        input.observedOverlay?.state !== 'active' ||
        readObservableLatestRepositoryValue(input.token, input.overlayId, input.manager) !== input.observedOverlay
    ) {
        return false;
    }

    return requireObservableLatestRepository(input.token, input.manager).delete(input.overlayId);
}

function setOverlay(input: SetOverlayInput): OverlayAdoptionOutcome {
    const repository = requireObservableLatestRepository(input.token, input.manager);
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

    const comparison = compareOverlayInfoIdentity(input.overlay, current);
    if (comparison === 'dominates') {
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

    return reportOverlayDrop(input.overlayId, 'dominated-dropped');
}

function setCurrentServerOverlay(input: SetOverlayInput): OverlayAdoptionOutcome {
    if (input.overlay.provenance !== 'server') {
        throw new TypeError('Current topology repair must contain a server overlay');
    }
    const repository = requireObservableLatestRepository(input.token, input.manager);
    const current = repository.read(input.overlayId);
    if (
        current?.provenance === 'server' &&
        compareOverlayInfoIdentity(input.overlay, current) === 'incomparable'
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
    const acceptedChange: AcceptedLayoutChange | undefined = input.token === acceptedOverlayRepositoryToken
        ? {
            overlayId: input.overlayId,
            held: repository.read(input.overlayId),
            taker: input.overlay,
            nowEpochMs: readOverlayRepositoryNow(input.manager),
            manager: input.manager
        }
        : undefined;
    emitOverlayAdoption(input.overlayId, outcome);
    repository.set(input.overlayId, input.overlay);
    if (acceptedChange !== undefined) {
        setLayoutTransitionForAcceptedChange(acceptedChange);
    }
    return outcome;
}

function setLayoutTransitionForAcceptedChange(change: AcceptedLayoutChange): void {
    const held = change.held;
    if (
        !isRoomLayoutOverlay(held, change.taker.groupRef) ||
        !isRoomLayoutOverlay(change.taker, change.taker.groupRef) ||
        compareOverlayInfoIdentity(change.taker, held) !== 'dominates'
    ) {
        clearLayoutTransition(change.overlayId, change.manager);
        return;
    }

    requireObservableLatestRepository(layoutTransitionRepositoryToken, change.manager).set(change.overlayId, {
        replaced: held,
        replacedBy: toOverlayLayoutIdentity(change.taker),
        replacedAtEpochMs: change.nowEpochMs
    });
}

function clearLayoutTransition(overlayId: string, manager?: RepositoryManager): void {
    requireObservableLatestRepository(layoutTransitionRepositoryToken, manager).delete(overlayId);
}

function readOverlayRepositoryNow(manager?: RepositoryManager): number {
    return (manager ?? defaultRepositoryManager).require(overlayRepositoryClockToken)();
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
    const accepted = readObservableLatestRepositoryValue(
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
