import type {
  AuditStamp,
  ClientPrincipal,
  ClientPrincipalRef,
  ClientSession,
} from '@shared/api/client-types.ts';
import type { MutationActor } from '@shared/api/mutation-actor.ts';
import type { RuntimeStateEntryValue } from '../../../../runtime-state/RuntimeStateJsonStore.ts';
import type { RuntimeStateEntry } from '../../../../runtime-state/RuntimeStateRepository.ts';
import { ClientMutationRejectedError } from '../../client-state-validation-primitives.ts';
import type {
  ClientMutationCommand,
  ClientMutationFacts,
  ClientMutationRead,
  ConditionalCandidate,
  NullableActorInput,
} from '../client-mutation-contracts.ts';

export function toClientAudit(command: ClientMutationCommand): AuditStamp {
  return toClientAuditInput({
    input: command.input,
    ref: command.aggregateRef,
    facts: command.facts,
    requestId: command.requestId,
  });
}

export function toClientAuditInput(
  input: Readonly<{
    input: NullableActorInput;
    ref: ClientPrincipalRef;
    facts: ClientMutationFacts;
    requestId?: string | null;
  }>,
): AuditStamp {
  return {
    atEpochMs: input.facts.nowEpochMs,
    actor: toClientMutationActor(input.input, input.ref, input.facts),
    reason: input.input.reason,
    traceId: input.input.traceId,
    requestId: input.requestId ?? null,
  };
}

export function toClientMutationActor(
  input: NullableActorInput,
  ref: ClientPrincipalRef,
  facts: ClientMutationFacts,
): MutationActor {
  if (input.actorSessionId !== null) {
    return {
      kind: 'session',
      sessionId: input.actorSessionId,
      principalId: input.actorPrincipalId ?? ref.principalId,
    };
  }
  if (input.actorPrincipalId !== null) {
    return { kind: 'principal', principalId: input.actorPrincipalId };
  }
  return { kind: 'service', serviceId: facts.serviceId };
}

export function toDefaultClientPrincipal(command: ClientMutationCommand): ClientPrincipal {
  const audit = toClientAudit(command);
  const connectInput =
    command.operation === 'connectSession' || command.operation === 'connectAuthorisedWsSession'
      ? command.input
      : undefined;
  const username = connectInput?.principalUsername ?? command.aggregateRef.principalId;
  return {
    ...command.aggregateRef,
    username,
    displayName: connectInput?.principalDisplayName ?? username,
    avatarUrl: null,
    authProvider: null,
    externalSubjectId: null,
    status: 'active',
    roles: connectInput?.principalRoles ?? [],
    metadata: {},
    snapshotVersion: 1,
    profileVersion: 1,
    presenceVersion: 1,
    created: audit,
    updated: audit,
    disabled: null,
    deleted: null,
    lastSeenAtEpochMs: null,
  };
}

export function bumpClientPrincipal(
  input: Readonly<{
    principal: ClientPrincipal;
    mutationInput: NullableActorInput;
    facts: ClientMutationFacts;
    requestId: string | null;
    domain: 'profile' | 'presence';
    lastSeenAtEpochMs?: number;
  }>,
): ClientPrincipal {
  const { principal, mutationInput, facts, requestId, domain, lastSeenAtEpochMs } = input;
  return {
    ...principal,
    snapshotVersion: principal.snapshotVersion + 1,
    profileVersion: principal.profileVersion + (domain === 'profile' ? 1 : 0),
    presenceVersion: principal.presenceVersion + (domain === 'presence' ? 1 : 0),
    updated: toClientAuditInput({ input: mutationInput, ref: principal, facts, requestId }),
    ...(lastSeenAtEpochMs === undefined
      ? {}
      : {
          lastSeenAtEpochMs: Math.max(
            principal.lastSeenAtEpochMs ?? Number.NEGATIVE_INFINITY,
            lastSeenAtEpochMs,
          ),
        }),
  };
}

export function requireClientPrincipal(
  read: ClientMutationRead,
  command: ClientMutationCommand,
): ClientPrincipal {
  if (!read.principal) {
    throw new ClientMutationRejectedError(
      `Client principal not found: ${command.aggregateRef.principalId}`,
    );
  }
  return read.principal.value;
}

export function requireClientSession(
  read: ClientMutationRead,
  command: ClientMutationCommand,
): ClientSession {
  if (!read.session) {
    throw new ClientMutationRejectedError(
      `Client session not found: ${'sessionId' in command ? command.sessionId : ''}`,
    );
  }
  return read.session.value;
}

export function toClientChildCandidate<T>(
  current: RuntimeStateEntryValue<T> | null,
  value: T,
  expiredEntry: RuntimeStateEntry | null = null,
): ConditionalCandidate<T> {
  return current
    ? { operation: 'update', value, expectedRevision: current.entry.revision }
    : expiredEntry
      ? { operation: 'update', value, expectedRevision: expiredEntry.revision }
      : { operation: 'insert', value };
}
