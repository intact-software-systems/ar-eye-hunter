import type { ResourceEntry } from '@shared/queuebox/ResourceEntry.ts';
import type { JsonWireValue } from '../protocol/json-wire-identity.ts';
import { decodePersistedAppInboxEnqueue } from './app-inbox-command-decoding.ts';
import { serializeCanonicalJsonWire } from './app-inbox-command-wire.ts';
import { AppInboxIdempotencyConflictError, type AppInboxEnqueueInput } from './app-inbox-contracts.ts';
import { hashCanonicalCommand } from './hash-canonical-command.ts';
import { toLogicalAppInboxCommand } from './logical-app-inbox-command.ts';

export async function assertMatchingAppInboxCommand(
    entry: ResourceEntry,
    incoming: AppInboxEnqueueInput<JsonWireValue, JsonWireValue>,
    receivedCommandIdentity: string
): Promise<void> {
    let existing: AppInboxEnqueueInput<JsonWireValue, JsonWireValue>;
    try {
        existing = decodePersistedAppInboxEnqueue(entry);
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
