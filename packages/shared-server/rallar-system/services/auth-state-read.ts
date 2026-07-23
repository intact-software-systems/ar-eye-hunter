import type { RuntimeStateEntryValue } from '../../runtime-state/RuntimeStateJsonStore.ts';
import {
    AuthSessionRepository,
    type PersistedAgentSessionTicket,
} from '../repositories/AuthSessionRepository.ts';
import { AuthUserRepository } from '../repositories/AuthUserRepository.ts';
import type { AuthCredentialIssuer } from './auth-credential-issuer.ts';
import type {
    AuthMutationCommand,
    AuthMutationFacts,
    AuthMutationRead,
    AuthSessionEntries,
} from './auth-state-contracts.ts';
import { requireMatchingCredentialDigest } from './auth-state-errors.ts';

export async function captureAuthMutationFacts(
    command: AuthMutationCommand,
    credentialIssuer: AuthCredentialIssuer,
): Promise<AuthMutationFacts> {
    switch (command.kind) {
        case 'issue-session': {
            const accessToken = await credentialIssuer.issueAccessToken(
                command.session.sessionId,
            );
            await requireMatchingCredentialDigest(
                accessToken,
                command.session.accessTokenDigest,
                'Auth session credential digest differs',
            );
            break;
        }
        case 'issue-ws-ticket': {
            const ticket = await credentialIssuer.issueWebSocketTicket(
                command.requestId,
                command.ticketRecord.sessionId,
            );
            await requireMatchingCredentialDigest(
                ticket,
                command.ticketRecord.ticketDigest,
                'Websocket ticket digest differs',
            );
            break;
        }
        case 'issue-agent-tickets':
            for (const ticket of command.tickets) {
                const accessToken = await credentialIssuer.issueAccessToken(
                    ticket.sessionId,
                );
                const presentedTicket = await credentialIssuer.issueAgentTicket(
                    command.requestId,
                    ticket.agentId,
                    ticket.sessionId,
                );
                await requireMatchingCredentialDigest(
                    accessToken,
                    ticket.accessTokenDigest,
                    'Agent credential digest differs',
                );
                await requireMatchingCredentialDigest(
                    presentedTicket,
                    ticket.ticketDigest,
                    'Agent credential digest differs',
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

export async function readAuthMutation(
    users: AuthUserRepository,
    sessions: AuthSessionRepository,
    command: AuthMutationCommand,
): Promise<AuthMutationRead> {
    switch (command.kind) {
        case 'register-user':
            return {
                kind: command.kind,
                byUsername: await users.findByNormalizedUsernameEntry(
                    command.user.normalizedUsername,
                ) ?? null,
                byClientId: await users.findByClientIdEntry(command.user.clientId) ?? null,
            };
        case 'issue-session':
            return {
                kind: command.kind,
                userByUsername: await users.findByNormalizedUsernameEntry(
                    command.authority.normalizedUsername,
                ) ?? null,
                userByClientId: await users.findByClientIdEntry(
                    command.authority.clientId,
                ) ?? null,
                byToken: await sessions.findSessionByAccessTokenDigestEntry(
                    command.session.accessTokenDigest,
                ) ?? null,
                bySession: await sessions.findSessionBySessionIdEntry(
                    command.session.sessionId,
                ) ?? null,
            };
        case 'logout-session':
            return {
                kind: command.kind,
                ...await readExpectedSessionEntries(sessions, command.expected),
            };
        case 'issue-ws-ticket': {
            const session = await sessions.findSessionBySessionIdEntry(
                command.ticketRecord.sessionId,
            ) ?? null;
            return {
                kind: command.kind,
                ticket: await sessions.findWebSocketTicketByDigestEntry(
                    command.ticketRecord.ticketDigest,
                ) ?? null,
                session,
            };
        }
        case 'consume-ws-ticket': {
            const ticket = await sessions.findWebSocketTicketByDigestEntry(
                command.ticketDigest,
            ) ?? null;
            return {
                kind: command.kind,
                ticket,
                session: ticket
                    ? await sessions.findSessionBySessionIdEntry(ticket.value.sessionId) ?? null
                    : null,
            };
        }
        case 'issue-agent-tickets': {
            const sessionEntries: AuthSessionEntries[] = [];
            const ticketEntries: Array<
                RuntimeStateEntryValue<PersistedAgentSessionTicket> | null
            > = [];
            for (const ticket of command.tickets) {
                sessionEntries.push({
                    byToken: await sessions.findSessionByAccessTokenDigestEntry(
                        ticket.accessTokenDigest,
                    ) ?? null,
                    bySession: await sessions.findSessionBySessionIdEntry(
                        ticket.sessionId,
                    ) ?? null,
                });
                ticketEntries.push(
                    await sessions.findAgentSessionTicketByDigestEntry(
                        ticket.ticketDigest,
                    ) ?? null,
                );
            }
            return {
                kind: command.kind,
                authority: await readExpectedSessionEntries(
                    sessions,
                    command.authority,
                ),
                sessions: sessionEntries,
                tickets: ticketEntries,
            };
        }
        case 'consume-agent-ticket': {
            const ticket = await sessions.findAgentSessionTicketByDigestEntry(
                command.ticketDigest,
            ) ?? null;
            return {
                kind: command.kind,
                ticket,
                session: ticket
                    ? await sessions.findSessionBySessionIdEntry(ticket.value.sessionId) ?? null
                    : null,
            };
        }
    }
}

async function readExpectedSessionEntries(
    sessions: AuthSessionRepository,
    expected: Readonly<{ sessionId: string; accessTokenDigest: string }>,
): Promise<AuthSessionEntries> {
    const bySession = await sessions.findSessionBySessionIdEntry(
        expected.sessionId,
    ) ?? null;
    let byToken = await sessions.findSessionByAccessTokenDigestEntry(
        expected.accessTokenDigest,
    ) ?? null;
    if (!byToken) {
        byToken = await sessions.findLegacySessionByAccessTokenDigestEntry(
            expected.accessTokenDigest,
        ) ?? null;
    }
    return { byToken, bySession };
}
