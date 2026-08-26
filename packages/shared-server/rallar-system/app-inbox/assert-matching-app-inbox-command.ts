import type { ResourceEntry } from '@shared/queuebox/ResourceEntry.ts';
import {
    hashMutationCommand,
    serializeCanonicalMutationCommand,
    type JsonWireValue
} from '../protocol/json-wire-identity.ts';
import { decodePersistedAppInboxEnqueue } from './app-inbox-command-decoding.ts';
import { AppInboxIdempotencyConflictError, type AppInboxEnqueueInput } from './app-inbox-contracts.ts';
import { toLogicalAppInboxCommand } from './logical-app-inbox-command.ts';

export async function assertMatchingAppInboxCommand(
    entry: ResourceEntry,
    incoming: AppInboxEnqueueInput,
    receivedCommandIdentity: string
): Promise<void> {
    let existing: AppInboxEnqueueInput;
    try {
        existing = decodePersistedAppInboxEnqueue(entry);
    }
    catch {
        const receivedCommandHash = await hashMutationCommand(toLogicalAppInboxCommand(incoming));
        throw new AppInboxIdempotencyConflictError(
            entry.key.resourceId,
            'invalid-existing-command',
            receivedCommandHash
        );
    }
    const existingCommandIdentity = serializeCanonicalMutationCommand(
        toLogicalAppInboxCommand(existing)
    );
    if (existingCommandIdentity === receivedCommandIdentity) {
        return;
    }
    const [existingCommandHash, receivedCommandHash] = await Promise.all([
        hashMutationCommand(toLogicalAppInboxCommand(existing)),
        hashMutationCommand(toLogicalAppInboxCommand(incoming))
    ]);
    throw new AppInboxIdempotencyConflictError(
        entry.key.resourceId,
        existingCommandHash,
        receivedCommandHash
    );
}
