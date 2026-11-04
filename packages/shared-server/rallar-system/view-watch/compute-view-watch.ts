import type { ClientSession } from '@shared/api/client-types.ts';
import type { GroupRef } from '@shared/api/group-types.ts';
import type { SessionPreviewWatchResult } from '@shared/api/views/view-watch.ts';
import { jsonEquals } from '@shared/repository/state-utils.ts';
import { computeRuntimeStateGuardedBatchWrite } from '../../runtime-state/guarded-batch/compute-runtime-state-guarded-batch-write.ts';
import type {
    RuntimeStateGuardedBatchEffect,
    RuntimeStateGuardedBatchUpdate,
    RuntimeStateGuardedBatchWrite
} from '../../runtime-state/guarded-batch/runtime-state-guarded-batch.ts';
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
    type ViewWatchRegistration
} from './view-watch-repository.ts';

export interface ViewWatchAuthorization {
    readonly ref: GroupRef;
    readonly guard: RuntimeStateGuardedBatchUpdate;
}

/** The preview domain supplies its exact authorization predecessor; the watch owner supplies session and slot fencing. */
export interface ViewWatchAuthorizer {
    read(ref: GroupRef): Promise<ViewWatchAuthorization | null>;
}

export interface ViewWatchRead {
    readonly command: ViewWatchCommand;
    readonly nowEpochMs: number;
    readonly auth: RuntimeStateEntryValue<PersistedAuthSession> | null;
    readonly client: RuntimeStateEntryValue<ClientSession> | null;
    readonly previous: RuntimeStateEntryValue<ViewWatchRegistration> | null;
    readonly previousResource: RuntimeStateEntryValue<ViewWatchRegistration> | null;
    readonly authorization: ViewWatchAuthorization | null;
}

export interface ViewWatchComputed {
    readonly result: SessionPreviewWatchResult;
    readonly storage: RuntimeStateGuardedBatchWrite;
}

export class ViewWatchAuthorizationError extends Error {
    readonly code = 'view-watch-authority-denied';
    readonly status = 403;
}

export function computeViewWatch(read: ViewWatchRead): ViewWatchComputed {
    const { command, previous, authorization } = read;
    assertViewWatchAuthority(read);
    const conflict = command.request.expectedRegistrationId !== (previous?.value.registrationId ?? null);
    if (!conflict && command.request.groupId !== null && authorization === null) {
        throw new ViewWatchAuthorizationError('The scheduled preview is not available');
    }
    const next = conflict ? previous?.value ?? null : toViewWatchRegistration(read);
    const effects: RuntimeStateGuardedBatchEffect[] = [{
        effectId: 'watch-client',
        ...unchangedGuard(CLIENT_STATE_SESSIONS_NAMESPACE, read.client!)
    }];
    if (conflict) {
        if (previous !== null) {
            effects.push({ effectId: 'watch-slot', ...unchangedGuard(VIEW_WATCH_SLOTS_NAMESPACE, previous) });
        }
    }
    else {
        if (authorization !== null) {
            effects.push({ effectId: 'watch-authority', ...authorization.guard });
        }
        effects.push(...computeWatchReplacement(read, next));
    }
    return {
        result: {
            status: conflict ? 'conflict' : 'applied',
            requestId: command.requestId,
            registrationId: next?.registrationId ?? null,
            groupId: next?.groupId ?? null
        },
        storage: computeRuntimeStateGuardedBatchWrite({
            guard: unchangedGuard(AUTH_SESSIONS_BY_SESSION_NAMESPACE, read.auth!),
            effects
        })
    };
}

function assertViewWatchAuthority(read: ViewWatchRead): void {
    const { command, auth, client, previous, previousResource } = read;
    if (
        auth === null || auth.value.clientId !== command.principalId || auth.value.sessionId !== command.sessionId ||
        auth.value.issuedAtEpochMs !== command.sessionIssuedAtEpochMs ||
        auth.value.expiresAtEpochMs !== command.sessionExpiresAtEpochMs ||
        auth.value.expiresAtEpochMs <= read.nowEpochMs || client === null || client.value.status !== 'active' ||
        client.value.expiresAtEpochMs <= read.nowEpochMs || client.value.transport !== 'ws' ||
        client.value.sessionId !== command.sessionId || client.value.principalId !== command.principalId ||
        client.value.applicationId !== command.scope.applicationId ||
        client.value.workspaceId !== command.scope.workspaceId ||
        client.value.generationId !== command.request.connectionGenerationId ||
        client.value.connectionId !== client.value.generationId
    ) {
        throw new ViewWatchAuthorizationError('A watch requires its current authenticated WebSocket generation');
    }
    if (
        previous !== null && (previous.value.principalId !== command.principalId ||
            previous.value.sessionId !== command.sessionId ||
            previous.value.sessionIssuedAtEpochMs !== command.sessionIssuedAtEpochMs ||
            previous.value.applicationId !== command.scope.applicationId ||
            previous.value.workspaceId !== command.scope.workspaceId)
    ) {
        throw new TypeError('View watch predecessor belongs to another authenticated identity');
    }
    if (
        (previous === null) !== (previousResource === null) ||
        (previous && !jsonEquals(previous.value, previousResource?.value))
    ) {
        throw new TypeError('View watch slot and resource lookup differ');
    }
    if (
        read.authorization !== null && (
            read.authorization.ref.groupId !== command.request.groupId ||
            read.authorization.ref.applicationId !== command.scope.applicationId ||
            read.authorization.ref.workspaceId !== command.scope.workspaceId
        )
    ) {
        throw new TypeError('View watch authority names another preview');
    }
}

function toViewWatchRegistration(read: ViewWatchRead): ViewWatchRegistration | null {
    const { command } = read;
    return command.request.groupId === null ? null : {
        ...command.scope,
        family: 'session-preview',
        principalId: command.principalId,
        sessionId: command.sessionId,
        clientInstanceId: read.client!.value.clientInstanceId,
        connectionGenerationId: command.request.connectionGenerationId,
        registrationId: command.requestId,
        groupId: command.request.groupId,
        sessionIssuedAtEpochMs: command.sessionIssuedAtEpochMs,
        expiresAtEpochMs: command.sessionExpiresAtEpochMs
    };
}

function unchangedGuard<T>(namespace: string, stored: RuntimeStateEntryValue<T>): RuntimeStateGuardedBatchUpdate {
    return {
        operation: 'update',
        namespace,
        key: stored.entry.key,
        value: stored.entry.value,
        expectedRevision: stored.entry.revision,
        expireAtTimestamp: stored.entry.expireAtTimestamp
    };
}

function computeWatchReplacement(
    read: ViewWatchRead,
    next: ViewWatchRegistration | null
): RuntimeStateGuardedBatchEffect[] {
    const { previous, previousResource } = read;
    const slotKey = viewWatchSlotKey({ ...read.command.scope, sessionId: read.command.sessionId });
    if (next === null) {
        return previous === null ? [] : [
            {
                effectId: 'watch-slot',
                operation: 'delete',
                namespace: VIEW_WATCH_SLOTS_NAMESPACE,
                key: slotKey,
                expectedRevision: previous.entry.revision
            },
            {
                effectId: 'watch-resource',
                operation: 'delete',
                namespace: VIEW_WATCH_RESOURCES_NAMESPACE,
                key: previousResource!.entry.key,
                expectedRevision: previousResource!.entry.revision
            }
        ];
    }
    const resourceKey = viewWatchResourceKey(next);
    const value = JSON.stringify(next);
    const common = { value, expireAtTimestamp: next.expiresAtEpochMs };
    const sameResource = previousResource?.entry.key === resourceKey;
    const effects: RuntimeStateGuardedBatchEffect[] = [
        {
            effectId: 'watch-slot',
            namespace: VIEW_WATCH_SLOTS_NAMESPACE,
            key: slotKey,
            ...common,
            ...(previous === null
                ? { operation: 'insert' }
                : { operation: 'update', expectedRevision: previous.entry.revision })
        },
        {
            effectId: 'watch-resource',
            namespace: VIEW_WATCH_RESOURCES_NAMESPACE,
            key: resourceKey,
            ...common,
            ...(sameResource
                ? { operation: 'update', expectedRevision: previousResource!.entry.revision }
                : { operation: 'insert' })
        }
    ];
    if (previousResource !== null && !sameResource) {
        effects.push({
            effectId: 'watch-previous-resource',
            operation: 'delete',
            namespace: VIEW_WATCH_RESOURCES_NAMESPACE,
            key: previousResource.entry.key,
            expectedRevision: previousResource.entry.revision
        });
    }
    return effects;
}
