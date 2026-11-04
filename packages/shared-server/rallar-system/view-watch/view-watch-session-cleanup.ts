import { jsonEquals } from '@shared/repository/state-utils.ts';
import { computeRuntimeStateGuardedBatchWrite } from '../../runtime-state/guarded-batch/compute-runtime-state-guarded-batch-write.ts';
import type { RuntimeStateGuardedBatchWrite } from '../../runtime-state/guarded-batch/runtime-state-guarded-batch.ts';
import type { RuntimeStateEntryValue } from '../../runtime-state/runtime-state-json-store.ts';
import type { ClientMutationCommand } from '../client-state/mutation/client-mutation-contracts.ts';
import {
    decodeViewWatchEntry,
    VIEW_WATCH_RESOURCES_NAMESPACE,
    VIEW_WATCH_SLOTS_NAMESPACE,
    ViewWatchRepository,
    type ViewWatchRegistration
} from './view-watch-repository.ts';

export interface ViewWatchSessionCleanupRead {
    readonly slot: RuntimeStateEntryValue<ViewWatchRegistration>;
    readonly resource: RuntimeStateEntryValue<ViewWatchRegistration>;
}

/** Registration CASes the same client row, so a close/expiry and replacement cannot both use the old session. */
export async function readViewWatchSessionCleanup(
    repository: ViewWatchRepository,
    command: ClientMutationCommand
): Promise<ViewWatchSessionCleanupRead | null> {
    if (
        command.operation !== 'disconnectSession' && command.operation !== 'disconnectAuthorisedWsSession' &&
        command.operation !== 'expireSession'
    ) {
        return null;
    }
    const slot = await repository.readSlot({ ...command.aggregateRef, sessionId: command.sessionId });
    if (slot === null || slot.value.connectionGenerationId !== command.input.generationId) {
        return null;
    }
    const resource = await repository.readResource(slot.value);
    if (resource === null) {
        throw new TypeError('Session cleanup watch has no resource lookup');
    }
    const read = { slot, resource };
    assertViewWatchSessionCleanup(command, read);
    return read;
}

export function assertViewWatchSessionCleanup(
    command: ClientMutationCommand,
    read: ViewWatchSessionCleanupRead | null
): void {
    if (read === null) {
        return;
    }
    const slot = decodeViewWatchEntry(read.slot.entry, 'slot');
    const resource = decodeViewWatchEntry(read.resource.entry, 'resource');
    if (
        (command.operation !== 'disconnectSession' && command.operation !== 'disconnectAuthorisedWsSession' &&
            command.operation !== 'expireSession') ||
        !jsonEquals(slot, read.slot) || !jsonEquals(resource, read.resource) ||
        !jsonEquals(slot.value, resource.value) ||
        slot.value.applicationId !== command.aggregateRef.applicationId ||
        slot.value.workspaceId !== command.aggregateRef.workspaceId ||
        slot.value.principalId !== command.aggregateRef.principalId || slot.value.sessionId !== command.sessionId ||
        slot.value.clientInstanceId !== command.clientInstanceId ||
        slot.value.connectionGenerationId !== command.input.generationId
    ) {
        throw new TypeError('Watch cleanup differs from the closing session generation');
    }
}

export function computeViewWatchSessionCleanup(
    read: ViewWatchSessionCleanupRead | null
): RuntimeStateGuardedBatchWrite | null {
    return read === null ? null : computeRuntimeStateGuardedBatchWrite({
        guard: {
            operation: 'delete',
            namespace: VIEW_WATCH_SLOTS_NAMESPACE,
            key: read.slot.entry.key,
            expectedRevision: read.slot.entry.revision
        },
        effects: [{
            effectId: 'watch-resource',
            operation: 'delete',
            namespace: VIEW_WATCH_RESOURCES_NAMESPACE,
            key: read.resource.entry.key,
            expectedRevision: read.resource.entry.revision
        }]
    });
}
