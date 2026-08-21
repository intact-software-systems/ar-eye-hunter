import type { RallarCrdtUpdateEnvelope } from '@shared/crdt/mod.ts';

import type {
    CrdtAppendCommand,
    CrdtMutationActor,
    CrdtMutationResponseAudience
} from '../mutation/crdt-mutation-contracts.ts';

export interface CurrentCrdtMutationSession {
    readonly clientId: string;
    readonly username: string;
    readonly sessionId: string;
}

export interface ReadCurrentCrdtMutationSessionInput {
    readonly sessionId: string;
    readonly atEpochMs: number;
}

export type ReadCurrentCrdtMutationSession = (
    input: ReadCurrentCrdtMutationSessionInput
) => Promise<CurrentCrdtMutationSession>;

export interface AuthenticatedCrdtAppendInput {
    readonly update: RallarCrdtUpdateEnvelope;
    readonly deliveryId: string;
    readonly trustedSessionId: string;
    readonly responseAudience: Omit<CrdtMutationResponseAudience, 'senderSessionId'>;
    readonly capturedAtEpochMs: number;
    readonly expireAtEpochMs: number;
}

export interface EnqueueAuthenticatedCrdtAppendInput {
    readonly update: RallarCrdtUpdateEnvelope;
    readonly deliveryId: string;
    readonly actor: CrdtMutationActor;
    readonly responseAudience: CrdtMutationResponseAudience;
    readonly capturedAtEpochMs: number;
    readonly expireAtEpochMs: number;
}

export interface CreateAndEnqueueAuthenticatedCrdtAppendDependencies {
    readonly serviceId: string;
    readonly readCurrentSession: ReadCurrentCrdtMutationSession;
    readonly enqueue: (input: EnqueueAuthenticatedCrdtAppendInput) => Promise<CrdtAppendCommand>;
}

export async function createAndEnqueueAuthenticatedCrdtAppend(
    input: AuthenticatedCrdtAppendInput,
    dependencies: CreateAndEnqueueAuthenticatedCrdtAppendDependencies
): Promise<CrdtAppendCommand> {
    const session = await dependencies.readCurrentSession({
        sessionId: input.trustedSessionId,
        atEpochMs: input.capturedAtEpochMs
    });
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
            serverId: dependencies.serviceId
        },
        responseAudience: {
            ...input.responseAudience,
            senderSessionId: session.sessionId
        },
        capturedAtEpochMs: input.capturedAtEpochMs,
        expireAtEpochMs: input.expireAtEpochMs
    });
}

function authenticationError(message: string, status: 403): Error {
    return Object.assign(new Error(message), {
        code: 'authorization-forbidden',
        status
    });
}
