import type { ClientSession } from '@shared/api/client-types.ts';
import type { ViewWatchResult } from '@shared/api/views/view-watch.ts';
import { computeRuntimeStateGuardedBatchWrite } from '../../runtime-state/guarded-batch/compute-runtime-state-guarded-batch-write.ts';
import type {
    RuntimeStateGuardedBatchDelete,
    RuntimeStateGuardedBatchEffect,
    RuntimeStateGuardedBatchExactUpdate,
    RuntimeStateGuardedBatchGuard,
    RuntimeStateGuardedBatchInsert,
    RuntimeStateGuardedBatchUpdate,
    RuntimeStateGuardedBatchWrite
} from '../../runtime-state/guarded-batch/runtime-state-guarded-batch.ts';
import {
    computeRuntimeStateObservations,
    type RuntimeStateObservation,
    type RuntimeStateObservations
} from '../../runtime-state/observation/runtime-state-observation.ts';
import type { RuntimeStateEntryValue } from '../../runtime-state/runtime-state-json-store.ts';
import { AUTH_SESSIONS_BY_SESSION_NAMESPACE } from '../auth/persistence/auth-storage-keys.ts';
import type { PersistedAuthSession } from '../auth/persistence/persisted-auth-session.ts';
import { CLIENT_STATE_SESSIONS_NAMESPACE } from '../client-state/persistence/client-state-runtime-namespaces.ts';
import type { ViewWatchCommand } from './view-watch-command.ts';
import {
    VIEW_WATCH_RESOURCES_NAMESPACE,
    VIEW_WATCH_SLOTS_NAMESPACE,
    viewWatchResourceKey,
    viewWatchSlotKey,
    type ViewWatchRegistration,
    type ViewWatchResource
} from './view-watch-repository.ts';

/**
 * The resource's publishers capture their watcher audience after reading this predecessor, so advancing it makes a
 * publisher that read the audience before this registration retry instead of missing it.
 */
export interface ViewWatchAuthorization {
    readonly resource: ViewWatchResource;
    readonly guard:
        | RuntimeStateGuardedBatchUpdate
        | RuntimeStateGuardedBatchInsert
        | RuntimeStateGuardedBatchExactUpdate;
}

/** The preview domain supplies its exact authorization predecessor; the watch owner supplies session and slot fencing. */
export interface ViewWatchAuthorityFacts {
    readonly expiresAtEpochMs: number;
    readonly changeId: string;
}

export interface ViewWatchAuthorizer {
    read(resource: ViewWatchResource, facts: ViewWatchAuthorityFacts): Promise<ViewWatchAuthorization | null>;
    /** A row only the departing interest kept alive, deleted in the write that moves the slot away. */
    readRelease(resource: ViewWatchResource): Promise<RuntimeStateGuardedBatchDelete | null>;
}

/** The slot and its resource lookup, read together and identical. */
export interface ViewWatchPredecessor {
    readonly slot: RuntimeStateEntryValue<ViewWatchRegistration>;
    readonly resource: RuntimeStateEntryValue<ViewWatchRegistration>;
}

export interface ViewWatchRead {
    readonly command: ViewWatchCommand;
    readonly nowEpochMs: number;
    readonly auth: RuntimeStateEntryValue<PersistedAuthSession> | null;
    readonly client: RuntimeStateEntryValue<ClientSession> | null;
    readonly predecessor: ViewWatchPredecessor | null;
    readonly authorization: ViewWatchAuthorization | null;
    readonly release: RuntimeStateGuardedBatchDelete | null;
}

/** A read whose authenticated WebSocket generation is current and whose selected view, if any, is available. */
export interface ViewWatchValidatedRead extends ViewWatchRead {
    readonly auth: RuntimeStateEntryValue<PersistedAuthSession>;
    readonly client: RuntimeStateEntryValue<ClientSession>;
}

export interface ViewWatchComputed {
    readonly result: ViewWatchResult;
    /** Session, generation and (for an unwritten slot) slot rows the outcome depends on; none is rewritten. */
    readonly observations: RuntimeStateObservations;
    readonly storage: RuntimeStateGuardedBatchWrite | null;
}

export function computeViewWatch(read: ViewWatchValidatedRead): ViewWatchComputed {
    const { command, predecessor } = read;
    const previous = predecessor?.slot.value ?? null;
    const conflict = command.request.expectedRegistrationId !== (previous?.registrationId ?? null);
    const next = conflict ? previous : toViewWatchRegistration(read);
    const storage = conflict ? null : computeWatchReplacement(read, next);
    const observations: RuntimeStateObservation[] = [
        { namespace: AUTH_SESSIONS_BY_SESSION_NAMESPACE, key: read.auth.entry.key, entry: read.auth.entry },
        { namespace: CLIENT_STATE_SESSIONS_NAMESPACE, key: read.client.entry.key, entry: read.client.entry }
    ];
    if (storage === null) {
        observations.push({
            namespace: VIEW_WATCH_SLOTS_NAMESPACE,
            key: toViewWatchSlotKey(command),
            entry: predecessor?.slot.entry ?? null
        });
    }
    return {
        result: {
            status: conflict ? 'conflict' : 'applied',
            requestId: command.requestId,
            registrationId: next?.registrationId ?? null,
            resourceId: next?.resourceId ?? null
        },
        observations: computeRuntimeStateObservations(observations),
        storage
    };
}

function toViewWatchRegistration(read: ViewWatchValidatedRead): ViewWatchRegistration | null {
    const { command } = read;
    return command.request.resourceId === null ? null : {
        ...command.scope,
        family: command.family,
        principalId: command.principalId,
        sessionId: command.sessionId,
        clientInstanceId: read.client.value.clientInstanceId,
        connectionGenerationId: command.request.connectionGenerationId,
        registrationId: command.requestId,
        resourceId: command.request.resourceId,
        sessionIssuedAtEpochMs: command.sessionIssuedAtEpochMs,
        expiresAtEpochMs: command.sessionExpiresAtEpochMs
    };
}

function toViewWatchSlotKey(command: ViewWatchCommand): string {
    return viewWatchSlotKey({ ...command.scope, sessionId: command.sessionId, family: command.family });
}

/** The slot is its own guard; an absent slot cleared to nothing writes no row. */
function computeWatchReplacement(
    read: ViewWatchValidatedRead,
    next: ViewWatchRegistration | null
): RuntimeStateGuardedBatchWrite | null {
    const { predecessor, authorization, release } = read;
    const releases: RuntimeStateGuardedBatchEffect[] = release === null
        ? []
        : [{ effectId: 'watch-previous-authority', ...release }];
    if (next === null) {
        return predecessor === null ? null : computeRuntimeStateGuardedBatchWrite({
            guard: {
                operation: 'delete',
                namespace: VIEW_WATCH_SLOTS_NAMESPACE,
                key: predecessor.slot.entry.key,
                expectedRevision: predecessor.slot.entry.revision
            },
            effects: [toResourceDelete('watch-resource', predecessor), ...releases]
        });
    }
    const value = JSON.stringify(next);
    const common = { value, expireAtTimestamp: next.expiresAtEpochMs };
    const resourceKey = viewWatchResourceKey(next);
    const sameResource = predecessor?.resource.entry.key === resourceKey;
    const guard: RuntimeStateGuardedBatchGuard = {
        namespace: VIEW_WATCH_SLOTS_NAMESPACE,
        key: toViewWatchSlotKey(read.command),
        ...common,
        ...(predecessor === null
            ? { operation: 'insert' }
            : { operation: 'update', expectedRevision: predecessor.slot.entry.revision })
    };
    const effects: RuntimeStateGuardedBatchEffect[] = [{
        effectId: 'watch-resource',
        namespace: VIEW_WATCH_RESOURCES_NAMESPACE,
        key: resourceKey,
        ...common,
        ...(predecessor !== null && sameResource
            ? { operation: 'update', expectedRevision: predecessor.resource.entry.revision }
            : { operation: 'insert' })
    }];
    if (predecessor !== null && !sameResource) {
        effects.push(toResourceDelete('watch-previous-resource', predecessor), ...releases);
    }
    if (authorization !== null) {
        effects.push({ effectId: 'watch-authority', ...authorization.guard });
    }
    return computeRuntimeStateGuardedBatchWrite({ guard, effects });
}

function toResourceDelete(effectId: string, predecessor: ViewWatchPredecessor): RuntimeStateGuardedBatchEffect {
    return {
        effectId,
        operation: 'delete',
        namespace: VIEW_WATCH_RESOURCES_NAMESPACE,
        key: predecessor.resource.entry.key,
        expectedRevision: predecessor.resource.entry.revision
    };
}
