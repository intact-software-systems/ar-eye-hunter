import { validateComputedProjection } from '../../../computed-data-validation.ts';
import type {
    GroupTopologyConfigMutationCommand,
    GroupTopologyConfigMutationComputed,
    GroupTopologyConfigMutationRead
} from './group-topology-config-mutation-contracts.ts';
import { resultFromTopologyConfigReceipt } from './topology-config-mutation-receipt.ts';
import { validateTopologyConfigIdempotencyInput } from './validate-topology-config-mutation-input.ts';

export interface ValidateTopologyConfigMutationIdempotencyInput {
    readonly command: GroupTopologyConfigMutationCommand;
    readonly read: GroupTopologyConfigMutationRead;
    readonly commandHash: string;
    readonly authorityFacts: Readonly<{ isPlatformAdmin: boolean; policyNowEpochMs: number; }>;
    readonly computed: Exclude<GroupTopologyConfigMutationComputed, { outcome: 'write' | 'claim' | 'no-op'; }>;
}

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

export function validateTopologyConfigMutationIdempotency(
    idempotencyValidation: ValidateTopologyConfigMutationIdempotencyInput
): void {
    validateTopologyConfigIdempotencyInput(
        idempotencyValidation.command,
        idempotencyValidation.read,
        idempotencyValidation.authorityFacts
    );
    if (
        idempotencyValidation.read.idempotency?.value.receipt.operation !==
            idempotencyValidation.command.operation
    ) {
        throw new TypeError('Topology config receipt operation differs from command');
    }
    const canonical = probeTopologyConfigMutationIdempotency(
        idempotencyValidation.command,
        idempotencyValidation.read,
        idempotencyValidation.commandHash
    );
    const projectionIssue = canonical.outcome === 'miss'
        ? undefined
        : validateComputedProjection(canonical, idempotencyValidation.computed, 'computed')[0];
    if (canonical.outcome === 'miss' || projectionIssue !== undefined) {
        throw new TypeError('Topology config idempotency result is not canonical');
    }
}
