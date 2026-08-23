import type { ResourceEntry } from '@shared/queuebox/ResourceEntry.ts';
import { readPersistedAppInboxEnqueue, serializeCanonicalJsonWire } from './app-inbox-command-wire.ts';
import { AppInboxIdempotencyConflictError, type AppInboxEnqueueInput } from './app-inbox-contracts.ts';
import { hashCanonicalCommand } from './hash-canonical-command.ts';
import { toLogicalAppInboxCommand } from './logical-app-inbox-command.ts';

export async function assertMatchingAppInboxCommand(
    entry: ResourceEntry,
    incoming: AppInboxEnqueueInput<unknown>,
    receivedCommandIdentity: string
): Promise<void> {
    let existing: AppInboxEnqueueInput<unknown>;
    try {
        existing = readPersistedAppInboxEnqueue(entry);
    }
    catch {
        const receivedCommandHash = await hashCanonicalCommand(toLogicalAppInboxCommand(incoming));
        throw new AppInboxIdempotencyConflictError(
            entry.key.resourceId,
            'invalid-existing-command',
            receivedCommandHash
        );
    }
    const existingCommandIdentity = serializeCanonicalJsonWire(
        toLogicalAppInboxCommand(existing)
    );
    if (existingCommandIdentity === receivedCommandIdentity) {
        return;
    }
    const [existingCommandHash, receivedCommandHash] = await Promise.all([
        hashCanonicalCommand(toLogicalAppInboxCommand(existing)),
        hashCanonicalCommand(toLogicalAppInboxCommand(incoming))
    ]);
    throw new AppInboxIdempotencyConflictError(
        entry.key.resourceId,
        existingCommandHash,
        receivedCommandHash
    );
}
