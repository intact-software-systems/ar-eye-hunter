import { hashAuthSecret } from '../repositories/AuthSessionRepository.ts';
import type { AuthCredentialIssuer } from './auth-credential-issuer.ts';
import type {
    AuthMutationCommand,
    AuthMutationPublicResult,
    AuthMutationResult,
} from './auth-state-contracts.ts';

export async function toAuthMutationPublicResult(
    command: AuthMutationCommand,
    result: AuthMutationResult,
    credentialIssuer: AuthCredentialIssuer,
): Promise<AuthMutationPublicResult> {
    switch (command.kind) {
        case 'register-user':
            if (!('registeredAtEpochMs' in result)) {
                throw new Error('Auth registration result kind differs');
            }
            return result;
        case 'logout-session':
            if (!('loggedOut' in result)) {
                throw new Error('Auth logout result kind differs');
            }
            return result;
        case 'issue-session': {
            const receipt = requireResultKind(result, 'session-issued');
            const accessToken = await resolveAccessToken(
                credentialIssuer,
                receipt.sessionId,
                receipt.accessTokenDigest,
            );
            return {
                clientId: receipt.clientId,
                username: receipt.username,
                accessToken,
                sessionId: receipt.sessionId,
                expiresAtEpochMs: receipt.expiresAtEpochMs,
            };
        }
        case 'issue-ws-ticket': {
            const receipt = requireResultKind(result, 'ws-ticket-issued');
            const ticket = await credentialIssuer.issueWebSocketTicket(
                command.requestId,
                receipt.sessionId,
            );
            await requireCredentialDigest(ticket, receipt.ticketDigest);
            return {
                ticket,
                sessionId: receipt.sessionId,
                expiresAtEpochMs: receipt.expiresAtEpochMs,
            };
        }
        case 'consume-ws-ticket':
        case 'consume-agent-ticket': {
            const receipt = requireResultKind(
                result,
                command.kind === 'consume-ws-ticket'
                    ? 'ws-ticket-consumed'
                    : 'agent-ticket-consumed',
            );
            const accessToken = await resolveAccessToken(
                credentialIssuer,
                receipt.sessionId,
                receipt.accessTokenDigest,
            );
            return {
                clientId: receipt.clientId,
                username: receipt.username,
                accessToken,
                sessionId: receipt.sessionId,
                issuedAtEpochMs: receipt.issuedAtEpochMs,
                expiresAtEpochMs: receipt.expiresAtEpochMs,
            };
        }
        case 'issue-agent-tickets': {
            const receipt = requireResultKind(result, 'agent-tickets-issued');
            const bySession = new Map(
                command.tickets.map((ticket) => [ticket.sessionId, ticket]),
            );
            return {
                tickets: await Promise.all(receipt.tickets.map(async (ticket) => {
                    const identity = bySession.get(ticket.sessionId);
                    if (!identity || identity.agentId !== ticket.agentId) {
                        throw new Error('Auth agent ticket result identity differs');
                    }
                    const plaintext = await credentialIssuer.issueAgentTicket(
                        command.requestId,
                        ticket.agentId,
                        ticket.sessionId,
                    );
                    await requireCredentialDigest(plaintext, ticket.ticketDigest);
                    return {
                        agentId: ticket.agentId,
                        ticket: plaintext,
                        sessionId: ticket.sessionId,
                        expiresAtEpochMs: ticket.expiresAtEpochMs,
                    };
                })),
            };
        }
    }
}

function requireResultKind<K extends Extract<AuthMutationResult, { kind: string }>['kind']>(
    result: AuthMutationResult,
    kind: K,
): Extract<AuthMutationResult, { kind: K }> {
    if (
        typeof result !== 'object' || result === null || !('kind' in result) ||
        result.kind !== kind
    ) {
        throw new Error(`Auth AppInbox result kind differs: ${kind}`);
    }
    return result as Extract<AuthMutationResult, { kind: K }>;
}

async function resolveAccessToken(
    credentialIssuer: AuthCredentialIssuer,
    sessionId: string,
    expectedDigest: string,
): Promise<string> {
    const derived = await credentialIssuer.issueAccessToken(sessionId);
    await requireCredentialDigest(derived, expectedDigest);
    return derived;
}

async function requireCredentialDigest(
    plaintext: string,
    expectedDigest: string,
): Promise<void> {
    if (await hashAuthSecret(plaintext) !== expectedDigest) {
        throw new Error('Auth AppInbox result credential digest differs');
    }
}
