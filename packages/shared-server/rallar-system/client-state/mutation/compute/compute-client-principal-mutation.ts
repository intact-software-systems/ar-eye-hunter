import type { ClientPrincipal } from '@shared/api/client-types.ts';

import { sameClientPrincipalState } from '../../client-state-semantic-equality.ts';
import type {
  ClientMutationCommand,
  ClientMutationComputed,
  ClientMutationRead,
} from '../client-mutation-contracts.ts';
import {
  computeClientMutationNoOp,
  computeClientMutationResult,
} from './compute-client-mutation-result.ts';
import { toClientAudit } from './compute-client-mutation-state.ts';

type PrincipalCommand = Extract<ClientMutationCommand, { operation: 'upsertPrincipal' }>;

export function computeClientPrincipalMutation(
  input: Readonly<{ command: PrincipalCommand; read: ClientMutationRead }>,
): ClientMutationComputed {
  const { command, read } = input;
  const existing = read.principal?.value;
  const principal = toClientPrincipal(command, existing);
  if (existing && sameClientPrincipalState(existing, principal)) {
    return computeClientMutationNoOp({ command, read });
  }
  return computeClientMutationResult({
    command,
    read,
    principal,
    instance: { operation: 'none' },
    session: { operation: 'none' },
    eventType: existing ? 'principal-updated' : 'principal-created',
  });
}

function toClientPrincipal(
  command: PrincipalCommand,
  existing: ClientPrincipal | undefined,
): ClientPrincipal {
  const audit = toClientAudit(command);
  const status = command.input.status ?? existing?.status ?? 'active';
  const base = {
    ...command.aggregateRef,
    username: command.input.username,
    displayName: command.input.displayName ?? existing?.displayName ?? null,
    avatarUrl: command.input.avatarUrl ?? existing?.avatarUrl ?? null,
    authProvider: command.input.authProvider ?? existing?.authProvider ?? null,
    externalSubjectId: command.input.externalSubjectId ?? existing?.externalSubjectId ?? null,
    roles: command.input.roles ?? existing?.roles ?? [],
    metadata: { ...(command.input.metadata ?? existing?.metadata ?? {}) },
    snapshotVersion: existing ? existing.snapshotVersion + 1 : 1,
    profileVersion: existing ? existing.profileVersion + 1 : 1,
    presenceVersion: existing?.presenceVersion ?? 1,
    created: existing?.created ?? audit,
    updated: audit,
    lastSeenAtEpochMs: command.input.lastSeenAtEpochMs ?? existing?.lastSeenAtEpochMs ?? null,
  };
  if (status === 'active') return { ...base, status, disabled: null, deleted: null };
  if (status === 'disabled') {
    return { ...base, status, disabled: existing?.disabled ?? audit, deleted: null };
  }
  return {
    ...base,
    status,
    disabled: existing?.disabled ?? null,
    deleted: existing?.deleted ?? audit,
  };
}
