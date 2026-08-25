import type { ClientSessionExpiryCandidate } from '../../../presence/session-expiry.ts';
import type { ClientMutationCommandInput } from '../client-mutation-contracts.ts';

type ClientExpiryCommandInput = Extract<ClientMutationCommandInput, { operation: 'expireSession'; }>;

export function toExpireClientSessionMutationInput(
    session: ClientSessionExpiryCandidate
): ClientExpiryCommandInput {
    const commandId = [
        'expire-client-session',
        session.sessionId,
        session.generationId,
        session.generationVersion,
        session.observedExpiresAtEpochMs
    ].join(':');
    return {
        operation: 'expireSession',
        aggregateRef: {
            applicationId: session.applicationId,
            workspaceId: session.workspaceId,
            principalId: session.principalId
        },
        clientInstanceId: session.clientInstanceId,
        sessionId: session.sessionId,
        commandId,
        requestId: commandId,
        input: {
            generationId: session.generationId,
            generationVersion: session.generationVersion,
            observedExpiresAtEpochMs: session.observedExpiresAtEpochMs,
            expiresAtEpochMs: session.observedExpiresAtEpochMs,
            actorPrincipalId: session.principalId,
            actorSessionId: session.sessionId,
            reason: 'expired',
            traceId: null
        }
    };
}
