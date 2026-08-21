import type { AuthCredentialIssuer } from '../../credentials/auth-credential-issuer.ts';
import { hashAuthSecret } from '../../credentials/hash-auth-secret.ts';
import type { AuthMutationCommand, AuthMutationFacts } from '../auth-mutation-contracts.ts';
import { AuthMutationRejectedError } from '../auth-mutation-rejected-error.ts';

export async function captureAuthMutationFacts(
    command: AuthMutationCommand,
    credentialIssuer: AuthCredentialIssuer
): Promise<AuthMutationFacts> {
    switch (command.kind) {
        case 'issue-session': {
            const accessToken = await credentialIssuer.issueAccessToken(command.session.sessionId);
            await requireMatchingCredentialDigest(
                accessToken,
                command.session.accessTokenDigest,
                'Auth session credential digest differs'
            );
            break;
        }
        case 'issue-ws-ticket': {
            const ticket = await credentialIssuer.issueWebSocketTicket(
                command.requestId,
                command.ticketRecord.sessionId
            );
            await requireMatchingCredentialDigest(
                ticket,
                command.ticketRecord.ticketDigest,
                'Websocket ticket digest differs'
            );
            break;
        }
        case 'issue-agent-tickets':
            for (const ticket of command.tickets) {
                const accessToken = await credentialIssuer.issueAccessToken(ticket.sessionId);
                const presentedTicket = await credentialIssuer.issueAgentTicket(
                    command.requestId,
                    ticket.agentId,
                    ticket.sessionId
                );
                await requireMatchingCredentialDigest(
                    accessToken,
                    ticket.accessTokenDigest,
                    'Agent credential digest differs'
                );
                await requireMatchingCredentialDigest(
                    presentedTicket,
                    ticket.ticketDigest,
                    'Agent credential digest differs'
                );
            }
            break;
        case 'register-user':
        case 'logout-session':
        case 'consume-ws-ticket':
        case 'consume-agent-ticket':
            break;
    }
    return { kind: command.kind };
}

async function requireMatchingCredentialDigest(
    credential: string,
    expectedDigest: string,
    message: string
): Promise<void> {
    if ((await hashAuthSecret(credential)) !== expectedDigest) {
        throw new AuthMutationRejectedError(message);
    }
}
