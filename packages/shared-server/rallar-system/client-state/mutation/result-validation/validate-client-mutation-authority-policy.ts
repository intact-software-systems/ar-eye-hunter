import { ClientMutationRejectedError } from '../../client-state-validation-primitives.ts';
import type { ClientMutationCommand, ClientMutationRead } from '../client-mutation-contracts.ts';

export function validateClientMutationAuthorityPolicy(
  command: ClientMutationCommand,
  read: ClientMutationRead,
): void {
  const authority = command.authority;
  if (authority.kind === 'system') {
    validateSystemClientMutationAuthority(command, read);
    return;
  }
  const session = read.authoritySession;
  if (
    command.operation === 'expireSession' ||
    authority.operation !== command.operation ||
    authority.applicationId !== command.aggregateRef.applicationId ||
    authority.workspaceId !== command.aggregateRef.workspaceId ||
    authority.principalId !== command.aggregateRef.principalId ||
    !session ||
    session.clientId !== authority.principalId ||
    session.sessionId !== authority.sessionId ||
    session.issuedAtEpochMs !== authority.sessionIssuedAtEpochMs ||
    session.expiresAtEpochMs !== authority.sessionExpiresAtEpochMs ||
    session.expiresAtEpochMs <= command.facts.nowEpochMs
  ) {
    throw new ClientMutationRejectedError(
      'Authenticated client authority is missing, expired, revoked, or mismatched.',
    );
  }
  validateIssuedClientMutationActor(command, session.clientId, session.sessionId);
}

function validateSystemClientMutationAuthority(
  command: ClientMutationCommand,
  read: ClientMutationRead,
): void {
  const authority = command.authority;
  if (
    authority.kind !== 'system' ||
    command.operation !== 'expireSession' ||
    authority.operation !== command.operation ||
    authority.serviceId !== command.facts.serviceId ||
    read.authoritySession !== null ||
    command.input.actorPrincipalId !== command.aggregateRef.principalId ||
    command.input.actorSessionId !== command.sessionId ||
    command.input.reason !== 'expired'
  ) {
    throw new ClientMutationRejectedError(
      'System authority is not permitted for this client command.',
    );
  }
}

function validateIssuedClientMutationActor(
  command: Exclude<ClientMutationCommand, { operation: 'expireSession' }>,
  authorityPrincipalId: string,
  authoritySessionId: string,
): void {
  if (
    command.input.actorPrincipalId !== null &&
    command.input.actorPrincipalId !== authorityPrincipalId
  ) {
    throw new ClientMutationRejectedError(
      'Client mutation actor principal differs from durable authority.',
    );
  }
  if (
    command.input.actorSessionId !== null &&
    command.input.actorSessionId !== authoritySessionId
  ) {
    throw new ClientMutationRejectedError(
      'Client mutation actor session differs from durable authority.',
    );
  }
  if ('sessionId' in command && command.sessionId !== authoritySessionId) {
    throw new ClientMutationRejectedError(
      'Client mutation session differs from durable authority.',
    );
  }
}
