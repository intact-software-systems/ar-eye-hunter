import type {
    GroupMutationCommand,
    GroupMutationIdempotencyProbe,
    GroupMutationRead
} from './group-mutation-contracts.ts';

export function probeGroupMutationIdempotency(
    command: GroupMutationCommand,
    read: GroupMutationRead,
    commandHash: string
): GroupMutationIdempotencyProbe {
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
