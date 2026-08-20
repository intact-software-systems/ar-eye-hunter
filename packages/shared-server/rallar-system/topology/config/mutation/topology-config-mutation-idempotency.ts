import type {
  GroupTopologyConfigMutationCommand,
  GroupTopologyConfigMutationComputed,
  GroupTopologyConfigMutationRead,
} from './group-topology-config-mutation-contracts.ts';
import { resultFromTopologyConfigReceipt } from './topology-config-mutation-receipt.ts';
import {
  requireTopologyConfigRequestId,
  validateTopologyConfigIdempotencyInput,
} from './validate-topology-config-mutation-input.ts';
import { validateGroupTopologyConfigMutationRecord } from './validate-topology-config-records.ts';

export interface ValidateTopologyConfigMutationIdempotencyInput {
  readonly command: GroupTopologyConfigMutationCommand;
  readonly read: GroupTopologyConfigMutationRead;
  readonly commandHash: string;
  readonly authorityFacts: Readonly<{ isPlatformAdmin: boolean }>;
  readonly computed: Exclude<
    GroupTopologyConfigMutationComputed,
    { outcome: 'write' | 'claim' | 'no-op' }
  >;
}

export function probeTopologyConfigMutationIdempotency(
  command: GroupTopologyConfigMutationCommand,
  read: GroupTopologyConfigMutationRead,
  commandHash: string,
):
  | Readonly<{ outcome: 'miss' }>
  | Extract<GroupTopologyConfigMutationComputed, { outcome: 'replay' }>
  | Extract<GroupTopologyConfigMutationComputed, { outcome: 'idempotency-conflict' }> {
  if (!read.idempotency) {
    return { outcome: 'miss' };
  }
  const record = read.idempotency.value;
  const requestId = requireTopologyConfigRequestId(command);
  validateGroupTopologyConfigMutationRecord(record, {
    groupRef: command.aggregateRef,
    requestId,
  });
  if (record.commandHash !== commandHash) {
    return {
      outcome: 'idempotency-conflict',
      existingCommandHash: record.commandHash,
      receivedCommandHash: commandHash,
    };
  }
  if (record.receipt.operation !== command.operation) {
    throw new TypeError('Topology config receipt operation differs from command');
  }
  return {
    outcome: 'replay',
    receipt: record.receipt,
    result: resultFromTopologyConfigReceipt(command, record.receipt),
  };
}

export function validateTopologyConfigMutationIdempotency(
  idempotencyValidation: ValidateTopologyConfigMutationIdempotencyInput,
): void {
  validateTopologyConfigIdempotencyInput(
    idempotencyValidation.command,
    idempotencyValidation.read,
    idempotencyValidation.authorityFacts,
  );
  const canonical = probeTopologyConfigMutationIdempotency(
    idempotencyValidation.command,
    idempotencyValidation.read,
    idempotencyValidation.commandHash,
  );
  if (
    canonical.outcome === 'miss' ||
    JSON.stringify(canonical) !== JSON.stringify(idempotencyValidation.computed)
  ) {
    throw new TypeError('Topology config idempotency result is not canonical');
  }
}
