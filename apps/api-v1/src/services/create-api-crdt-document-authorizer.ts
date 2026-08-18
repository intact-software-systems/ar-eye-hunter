import type { ClientPrincipalRef, ClientSnapshot } from '@shared/api/client-types.ts';
import { DEFAULT_STATE_WORKSPACE_ID } from '@shared/api/state-types.ts';
import type { GroupRef, GroupSnapshot } from '@shared/api/group-types.ts';
import type { RallarCrdtDocumentRef } from '@shared/crdt/mod.ts';
import type {
  CrdtMutationResponseAudience,
} from '@shared-server/rallar-system/crdt/mutation/crdt-mutation-contracts.ts';
// deno-fmt-ignore
import type { ClientStateSnapshotReadThroughCache } from '@shared-server/rallar-system/services/\
client-state-snapshot-read-through-cache.ts';

import type {
  CurrentMutationAuthority,
  CurrentMutationDocumentAuthorization,
} from './create-api-mutation-inbox-factories.ts';

export interface ApiCrdtDocumentAuthorizerOptions {
  readonly readGroupSnapshot: (
    ref: GroupRef,
  ) => Promise<GroupSnapshot | null | undefined>;
  readonly readClientSnapshot: (
    ref: ClientPrincipalRef,
  ) => Promise<ClientSnapshot | null | undefined>;
  readonly nowEpochMs: () => number;
}

interface CurrentClientDocumentAuthorizationInput {
  readonly options: ApiCrdtDocumentAuthorizerOptions;
  readonly applicationId: string;
  readonly workspaceId: string | undefined;
  readonly principalId: string;
  readonly sessionId: string;
}

export interface AuthorizeCrdtDocumentAccessInput {
  readonly document: RallarCrdtDocumentRef;
  readonly actorPrincipalId: string;
  readonly sessionId: string;
}

export interface CurrentClientSnapshotRef {
  readonly applicationId: string;
  readonly workspaceId?: string;
  readonly principalId: string;
}

export function createApiCrdtDocumentAuthorizer(
  options: ApiCrdtDocumentAuthorizerOptions,
): CurrentMutationAuthority['authorizeDocument'] {
  return async (command, session) => {
    if (!responseAudienceMatchesDocument(command.responseAudience, command.document)) {
      return denied();
    }
    return await authorizeCrdtDocumentAccess(options, {
      document: command.document,
      actorPrincipalId: command.actor.principalId,
      sessionId: session.sessionId,
    });
  };
}

/**
 * Authorize a caller against a CRDT document by membership and live session,
 * independent of any response-routing audience. Every transport that reads or
 * mutates a document — the WS bridge, the durable mutation inbox, and the
 * synchronous HTTP catch-up route — must gate on this so authorization cannot be
 * bypassed by choosing a different transport.
 */
export async function authorizeCrdtDocumentAccess(
  options: ApiCrdtDocumentAuthorizerOptions,
  input: AuthorizeCrdtDocumentAccessInput,
): Promise<CurrentMutationDocumentAuthorization> {
  const { document, actorPrincipalId, sessionId } = input;
  if (document.scope === 'room') {
    if (!document.roomRef) {
      return denied();
    }
    const snapshot = await options.readGroupSnapshot(document.roomRef);
    const member = snapshot?.members.find((candidate) =>
      candidate.principalId === actorPrincipalId &&
      candidate.status === 'active'
    );
    const activeSession = snapshot?.activeSessions.find((candidate) =>
      candidate.principalId === actorPrincipalId &&
      candidate.sessionId === sessionId &&
      candidate.status === 'active' &&
      candidate.expiresAtEpochMs > options.nowEpochMs()
    );
    return member && activeSession ? allowed() : denied();
  }
  if (document.scope === 'principal') {
    if (document.principalId !== actorPrincipalId) {
      return denied();
    }
    return await authorizeCurrentClientDocument({
      options,
      applicationId: document.applicationId,
      workspaceId: document.workspaceId,
      principalId: document.principalId,
      sessionId,
    });
  }
  if (document.scope === 'app') {
    return await authorizeCurrentClientDocument({
      options,
      applicationId: document.applicationId,
      workspaceId: document.workspaceId,
      principalId: actorPrincipalId,
      sessionId,
    });
  }
  return denied();
}

function responseAudienceMatchesDocument(
  responseAudience: CrdtMutationResponseAudience,
  document: RallarCrdtDocumentRef,
): boolean {
  if (document.scope === 'room') {
    const roomRef = document.roomRef;
    if (!roomRef) {
      return false;
    }
    return responseAudience.kind === 'room' &&
      responseAudience.contextId === roomRef.groupId;
  }
  if (document.scope === 'principal') {
    return responseAudience.kind === 'principal' &&
      responseAudience.contextId === document.principalId;
  }
  if (document.scope === 'app') {
    return responseAudience.kind === 'app' &&
      responseAudience.contextId === document.applicationId;
  }
  return false;
}

export function findCurrentClientSnapshot(
  cache: ClientStateSnapshotReadThroughCache,
  ref: CurrentClientSnapshotRef,
): ClientSnapshot | undefined {
  return cache.findByRef({
    applicationId: ref.applicationId,
    workspaceId: ref.workspaceId ?? DEFAULT_STATE_WORKSPACE_ID,
    principalId: ref.principalId,
  });
}

function allowed(): CurrentMutationDocumentAuthorization {
  return { allowed: true, code: 'allowed' };
}

function denied(): CurrentMutationDocumentAuthorization {
  return { allowed: false, code: 'authorization-scope-denied' };
}

async function authorizeCurrentClientDocument(
  input: CurrentClientDocumentAuthorizationInput,
): Promise<CurrentMutationDocumentAuthorization> {
  const { options, applicationId, workspaceId, principalId, sessionId } = input;
  const snapshot = await options.readClientSnapshot({
    applicationId,
    workspaceId: workspaceId ?? DEFAULT_STATE_WORKSPACE_ID,
    principalId,
  });
  const active = snapshot?.principal.status === 'active' &&
    snapshot.activeSessions.some((candidate) =>
      candidate.sessionId === sessionId && candidate.status === 'active' &&
      candidate.expiresAtEpochMs > options.nowEpochMs()
    );
  return active ? allowed() : denied();
}
