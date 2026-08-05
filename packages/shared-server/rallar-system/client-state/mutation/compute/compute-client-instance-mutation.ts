import type { ClientInstance } from '@shared/api/client-types.ts';

import { sameClientInstanceState } from '../../client-state-semantic-equality.ts';
import type {
  ClientMutationCommand,
  ClientMutationComputed,
  ClientMutationRead,
} from '../client-mutation-contracts.ts';
import {
  computeClientMutationNoOp,
  computeClientMutationResult,
} from './compute-client-mutation-result.ts';
import {
  bumpClientPrincipal,
  toClientAudit,
  toClientChildCandidate,
  toDefaultClientPrincipal,
} from './compute-client-mutation-state.ts';

type InstanceCommand = Extract<ClientMutationCommand, { operation: 'upsertInstance' }>;

export function computeClientInstanceMutation(
  input: Readonly<{ command: InstanceCommand; read: ClientMutationRead }>,
): ClientMutationComputed {
  const { command, read } = input;
  const principal = read.principal?.value ?? toDefaultClientPrincipal(command);
  const existing = read.instance?.value;
  const instance = toClientInstance(command, existing);
  if (existing && sameClientInstanceState(existing, instance)) {
    return computeClientMutationNoOp({ command, read });
  }
  const nextPrincipal = read.principal
    ? bumpClientPrincipal({
        principal,
        mutationInput: command.input,
        facts: command.facts,
        requestId: command.requestId,
        domain: 'profile',
      })
    : principal;
  return computeClientMutationResult({
    command,
    read,
    principal: nextPrincipal,
    instance: toClientChildCandidate(read.instance, instance),
    session: { operation: 'none' },
    eventType:
      instance.status === 'revoked'
        ? 'instance-revoked'
        : existing
          ? 'instance-updated'
          : 'instance-registered',
    clientInstanceId: command.clientInstanceId,
  });
}

function toClientInstance(
  command: InstanceCommand,
  existing: ClientInstance | undefined,
): ClientInstance {
  const audit = toClientAudit(command);
  const status = command.input.status ?? existing?.status ?? 'active';
  const base = {
    ...command.aggregateRef,
    clientInstanceId: command.clientInstanceId,
    platform: command.input.platform ?? existing?.platform ?? 'unknown',
    deviceLabel: command.input.deviceLabel ?? existing?.deviceLabel ?? null,
    appVersion: command.input.appVersion ?? existing?.appVersion ?? null,
    userAgent: command.input.userAgent ?? existing?.userAgent ?? null,
    capabilities: command.input.capabilities ?? existing?.capabilities ?? [],
    registered: existing?.registered ?? audit,
    updated: audit,
  };
  if (status === 'active') return { ...base, status, revoked: null };
  return { ...base, status, revoked: existing?.revoked ?? audit };
}
