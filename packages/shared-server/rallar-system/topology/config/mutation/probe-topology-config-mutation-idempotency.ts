import type {
    GroupTopologyConfigMutationCommand,
    GroupTopologyConfigMutationComputed,
    GroupTopologyConfigMutationRead
} from './group-topology-config-mutation-contracts.ts';
import { resultFromTopologyConfigReceipt } from './topology-config-mutation-receipt.ts';

export function probeTopologyConfigMutationIdempotency(
    command: GroupTopologyConfigMutationCommand,
    read: GroupTopologyConfigMutationRead,
    commandHash: string
):
    | Readonly<{ outcome: 'miss'; }>
    | Extract<GroupTopologyConfigMutationComputed, { outcome: 'replay'; }>
    | Extract<GroupTopologyConfigMutationComputed, { outcome: 'idempotency-conflict'; }> {
    if (!read.idempotency) {
        return { outcome: 'miss' };
    }
    const record = read.idempotency.value;
    if (record.commandHash !== commandHash) {
        return {
            outcome: 'idempotency-conflict',
            existingCommandHash: record.commandHash,
            receivedCommandHash: commandHash
        };
    }
    return {
        outcome: 'replay',
        receipt: record.receipt,
        result: resultFromTopologyConfigReceipt(command, record.receipt)
    };
}
