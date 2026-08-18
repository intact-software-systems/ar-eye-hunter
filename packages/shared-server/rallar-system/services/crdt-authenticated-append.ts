import type { RallarCrdtUpdateEnvelope } from '@shared/crdt/mod.ts';
import type {
  CrdtAppendCommand,
  CrdtMutationResponseAudience,
} from '../crdt/mutation/crdt-mutation-contracts.ts';

export interface CurrentCrdtMutationSession {
  readonly clientId: string;
  readonly username: string;
  readonly sessionId: string;
}

export type ResolveCurrentCrdtMutationSession = (
  sessionId: string,
  atEpochMs: number,
) => Promise<CurrentCrdtMutationSession>;

export interface AuthenticatedCrdtAppendInput {
  readonly update: RallarCrdtUpdateEnvelope;
  readonly deliveryId: string;
  readonly trustedSessionId: string;
  readonly responseAudience: Omit<CrdtMutationResponseAudience, 'senderSessionId'>;
  readonly capturedAtEpochMs: number;
  readonly expireAtEpochMs: number;
}

export async function createAndEnqueueAuthenticatedCrdtAppend(
  input: AuthenticatedCrdtAppendInput,
  dependencies: Readonly<{
    serviceId: string;
    resolveCurrentSession?: ResolveCurrentCrdtMutationSession;
    enqueue(
      input: Readonly<{
        update: RallarCrdtUpdateEnvelope;
        deliveryId: string;
        actor: Readonly<{
          actorId: string;
          principalId: string;
          sessionId: string;
          serverId: string;
        }>;
        responseAudience: CrdtMutationResponseAudience;
        capturedAtEpochMs: number;
        expireAtEpochMs: number;
      }>,
    ): Promise<CrdtAppendCommand>;
  }>,
): Promise<CrdtAppendCommand> {
  if (!dependencies.resolveCurrentSession) {
    throw authenticationError('CRDT current session resolver is unavailable', 401);
  }
  const session = await dependencies.resolveCurrentSession(
    input.trustedSessionId,
    input.capturedAtEpochMs,
  );
  if (session.sessionId !== input.trustedSessionId) {
    throw authenticationError('CRDT current session identity differs', 403);
  }
  return await dependencies.enqueue({
    update: input.update,
    deliveryId: input.deliveryId,
    actor: {
      actorId: session.clientId,
      principalId: session.username,
      sessionId: session.sessionId,
      serverId: dependencies.serviceId,
    },
    responseAudience: {
      ...input.responseAudience,
      senderSessionId: session.sessionId,
    },
    capturedAtEpochMs: input.capturedAtEpochMs,
    expireAtEpochMs: input.expireAtEpochMs,
  });
}

function authenticationError(message: string, status: 401 | 403): Error {
  return Object.assign(new Error(message), {
    code: status === 401 ? 'authentication-missing' : 'authorization-forbidden',
    status,
  });
}
