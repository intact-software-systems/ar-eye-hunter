import type { ResourceEntry } from '@shared/queuebox/ResourceEntry.ts';

import {
    computeMutationCommandDigest,
    serializeCanonicalMutationCommand,
    type JsonWireValue
} from '../protocol/json-wire-identity.ts';
import { decodePersistedAppInboxEnqueue } from './app-inbox-command-decoding.ts';
import { AppInboxIdempotencyConflictError, type AppInboxEnqueueInput } from './app-inbox-contracts.ts';
import { toLogicalAppInboxCommand } from './logical-app-inbox-command.ts';

export function assertMatchingAppInboxCommand(
    entry: ResourceEntry,
    incoming: AppInboxEnqueueInput,
    receivedCommandIdentity: string
): void {
    let existing: AppInboxEnqueueInput;
    try {
        existing = decodePersistedAppInboxEnqueue(entry);
    }
    catch {
        const receivedCommandHash = computeMutationCommandDigest(toLogicalAppInboxCommand(incoming));
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
    throw new AppInboxIdempotencyConflictError(
        entry.key.resourceId,
        computeMutationCommandDigest(toLogicalAppInboxCommand(existing)),
        computeMutationCommandDigest(toLogicalAppInboxCommand(incoming))
    );
}
