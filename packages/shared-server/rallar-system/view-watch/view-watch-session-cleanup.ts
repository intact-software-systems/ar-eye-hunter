import { VIEW_WATCH_FAMILIES } from '@shared/api/views/view-watch.ts';
import { jsonEquals } from '@shared/repository/state-utils.ts';
import { computeRuntimeStateGuardedBatchWrite } from '../../runtime-state/guarded-batch/compute-runtime-state-guarded-batch-write.ts';
import type {
    RuntimeStateGuardedBatchEffect,
    RuntimeStateGuardedBatchWrite
} from '../../runtime-state/guarded-batch/runtime-state-guarded-batch.ts';
import type { RuntimeStateEntryValue } from '../../runtime-state/runtime-state-json-store.ts';
import type { ClientMutationCommand } from '../client-state/mutation/client-mutation-contracts.ts';
import {
    decodeViewWatchEntry,
    VIEW_WATCH_RESOURCES_NAMESPACE,
    VIEW_WATCH_SLOTS_NAMESPACE,
    ViewWatchRepository,
    type ViewWatchRegistration
} from './view-watch-repository.ts';

interface ViewWatchCleanupRegistration {
    readonly slot: RuntimeStateEntryValue<ViewWatchRegistration>;
    readonly resource: RuntimeStateEntryValue<ViewWatchRegistration>;
}

export interface ViewWatchSessionCleanupRead {
    readonly registrations: readonly ViewWatchCleanupRegistration[];
}

/** Each family shares the closing client predecessor, so a new generation cannot be cleared by an old close. */
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
    const registrations: ViewWatchCleanupRegistration[] = [];
    for (const family of VIEW_WATCH_FAMILIES) {
        const slot = await repository.readSlot({ ...command.aggregateRef, sessionId: command.sessionId, family });
        if (slot === null || slot.value.connectionGenerationId !== command.input.generationId) {
            continue;
        }
        const resource = await repository.readResource(slot.value);
        if (resource === null) {
            throw new TypeError('Session cleanup watch has no resource lookup');
        }
        registrations.push({ slot, resource });
    }
    const read = registrations.length === 0 ? null : { registrations };
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
    if (
        read.registrations.length === 0 || read.registrations.length > VIEW_WATCH_FAMILIES.length ||
        new Set(read.registrations.map(({ slot }) => slot.value.family)).size !== read.registrations.length
    ) {
        throw new TypeError('Watch cleanup must name each captured family exactly once');
    }
    for (const registration of read.registrations) {
        assertCleanupRegistration(command, registration);
    }
}

function assertCleanupRegistration(command: ClientMutationCommand, read: ViewWatchCleanupRegistration): void {
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
    if (read === null) {
        return null;
    }
    const effects: RuntimeStateGuardedBatchEffect[] = read.registrations.flatMap(({ slot, resource }) => [
        {
            effectId: `watch-slot:${slot.value.family}`,
            operation: 'delete',
            namespace: VIEW_WATCH_SLOTS_NAMESPACE,
            key: slot.entry.key,
            expectedRevision: slot.entry.revision
        },
        {
            effectId: `watch-resource:${slot.value.family}`,
            operation: 'delete',
            namespace: VIEW_WATCH_RESOURCES_NAMESPACE,
            key: resource.entry.key,
            expectedRevision: resource.entry.revision
        }
    ]);
    const [first, ...rest] = effects;
    if (first.operation !== 'delete') {
        throw new TypeError('Watch cleanup requires conditional deletes');
    }
    return computeRuntimeStateGuardedBatchWrite({
        guard: {
            operation: 'delete',
            namespace: first.namespace,
            key: first.key,
            expectedRevision: first.expectedRevision
        },
        effects: rest
    });
}
