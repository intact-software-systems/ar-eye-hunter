import { assertGroupMutationCommand } from './command-validation/assert-group-mutation-command.ts';
import type {
    GroupMutationCommand,
    GroupMutationIdempotencyProbe,
    GroupMutationRead
} from './group-mutation-contracts.ts';
import { assertGroupMutationRead } from './state-validation/assert-group-mutation-read.ts';
import { assertCommandHash } from './state-validation/assert-group-mutation-result.ts';

export function probeGroupMutationIdempotency(
    command: GroupMutationCommand,
    read: GroupMutationRead,
    commandHash: string
): GroupMutationIdempotencyProbe {
    assertGroupMutationCommand(command);
    assertGroupMutationRead(read, command);
    assertCommandHash(commandHash, 'Group mutation commandHash');
    if (!read.idempotency) {
        return { outcome: 'miss' };
    }
    const record = read.idempotency.value;
    if (record.receipt.commandId !== command.commandId) {
        throw new TypeError('Stored group idempotency receipt command differs from command identity');
    }
    return record.commandHash === commandHash
        ? { outcome: 'replay', receipt: record.receipt }
        : {
            outcome: 'idempotency-conflict',
            existingCommandHash: record.commandHash,
            receivedCommandHash: commandHash
        };
}
