import type { AuthSession } from '@shared/api/api-config.ts';
import type { GroupSnapshot } from '@shared/api/group-types.ts';
import {
  canReadGroupSnapshot,
  canSendRoomMessage,
  canUpdateGroupSnapshot,
  GroupPolicyDeniedError,
} from '@shared-server/rallar-system/group-policy.ts';

export type RelicRestAuthMode = 'authenticated' | 'group-policy';

export type RelicRestAuthSession = Pick<AuthSession, 'clientId' | 'sessionId'>;

type RelicRestAuthInput = Readonly<{
  mode: RelicRestAuthMode;
  gameId: string;
  session: RelicRestAuthSession;
  snapshot?: GroupSnapshot;
}>;

export class RelicRestGroupNotFoundError extends Error {
  public override readonly name = 'RelicRestGroupNotFoundError';
  public readonly status = 404;

  public constructor(gameId: string) {
    super(`Relic group not found: ${gameId}`);
  }
}

export function readRelicRestAuthMode(env: Pick<Deno.Env, 'get'>): RelicRestAuthMode {
  const raw = env.get('RELIC_REST_AUTH_MODE')?.trim().toLowerCase();
  if (!raw || raw === 'authenticated') {
    return 'authenticated';
  }
  if (raw === 'group-policy') {
    return 'group-policy';
  }

  throw new Error('RELIC_REST_AUTH_MODE must be authenticated or group-policy.');
}

export function authorizeRelicSnapshotRead(input: RelicRestAuthInput): void {
  if (input.mode === 'authenticated') {
    return;
  }

  const result = canReadGroupSnapshot({
    snapshot: requireRelicGroupSnapshot(input),
    actor: actorFromSession(input.session),
  });
  if (!result.allowed) {
    throw new GroupPolicyDeniedError(result);
  }
}

export function authorizeRelicCommand(input: RelicRestAuthInput): void {
  if (input.mode === 'authenticated') {
    return;
  }

  const result = canSendRoomMessage({
    snapshot: requireRelicGroupSnapshot(input),
    actor: actorFromSession(input.session),
    senderSessionId: input.session.sessionId,
  });
  if (!result.allowed) {
    throw new GroupPolicyDeniedError(result);
  }
}

export function authorizeRelicReset(input: RelicRestAuthInput): void {
  if (input.mode === 'authenticated') {
    return;
  }

  const result = canUpdateGroupSnapshot({
    snapshot: requireRelicGroupSnapshot(input),
    actor: actorFromSession(input.session),
  });
  if (!result.allowed) {
    throw new GroupPolicyDeniedError(result);
  }
}

function requireRelicGroupSnapshot(input: RelicRestAuthInput): GroupSnapshot {
  if (!input.snapshot) {
    throw new RelicRestGroupNotFoundError(input.gameId);
  }

  return input.snapshot;
}

function actorFromSession(session: RelicRestAuthSession) {
  return {
    principalId: session.clientId,
    sessionId: session.sessionId,
  };
}
