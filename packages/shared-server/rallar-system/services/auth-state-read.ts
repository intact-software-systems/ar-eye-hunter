import type { RuntimeStateEntryValue } from '../../runtime-state/RuntimeStateJsonStore.ts';
import {
    AuthSessionRepository,
    type PersistedAgentSessionTicket,
} from '../repositories/AuthSessionRepository.ts';
import { AuthUserRepository } from '../repositories/AuthUserRepository.ts';
import * as authMutationFacts from '../auth/mutation/read/capture-auth-mutation-facts.ts';
import type {
    AuthMutationCommand,
    AuthMutationRead,
    AuthSessionEntries,
} from '../auth/mutation/auth-mutation-contracts.ts';

export const captureAuthMutationFacts = authMutationFacts.captureAuthMutationFacts;

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
            {
            const byToken = await sessions.readSessionByAccessTokenDigestEntry(
                command.session.accessTokenDigest,
            );
            const bySession = await sessions.readSessionBySessionIdEntry(
                command.session.sessionId,
            );
            return {
                kind: command.kind,
                userByUsername: await users.findByNormalizedUsernameEntry(
                    command.authority.normalizedUsername,
                ) ?? null,
                userByClientId: await users.findByClientIdEntry(
                    command.authority.clientId,
                ) ?? null,
                byToken: byToken.value ?? null,
                bySession: bySession.value ?? null,
                expiredByTokenEntry: byToken.expiredEntry ?? null,
                expiredBySessionEntry: bySession.expiredEntry ?? null,
            };
            }
        case 'logout-session':
            return {
                kind: command.kind,
                ...await readExpectedSessionEntries(sessions, command.expected),
            };
        case 'issue-ws-ticket': {
            const ticket = await sessions.readWebSocketTicketByDigestEntry(
                command.ticketRecord.ticketDigest,
            );
            const session = await sessions.findSessionBySessionIdEntry(
                command.ticketRecord.sessionId,
            ) ?? null;
            return {
                kind: command.kind,
                ticket: ticket.value ?? null,
                expiredTicketEntry: ticket.expiredEntry ?? null,
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
            const expiredTicketEntries = [] as Array<
                import('../../runtime-state/RuntimeStateRepository.ts').RuntimeStateEntry | null
            >;
            for (const ticket of command.tickets) {
                sessionEntries.push(await readExpectedSessionEntries(sessions, ticket));
                const ticketRead = await sessions.readAgentSessionTicketByDigestEntry(
                    ticket.ticketDigest,
                );
                ticketEntries.push(ticketRead.value ?? null);
                expiredTicketEntries.push(ticketRead.expiredEntry ?? null);
            }
            return {
                kind: command.kind,
                authority: await readExpectedSessionEntries(
                    sessions,
                    command.authority,
                ),
                sessions: sessionEntries,
                tickets: ticketEntries,
                expiredTicketEntries,
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
    const bySession = await sessions.readSessionBySessionIdEntry(
        expected.sessionId,
    );
    let byToken = await sessions.readSessionByAccessTokenDigestEntry(
        expected.accessTokenDigest,
    );
    if (!byToken.value && !byToken.expiredEntry) {
        const legacy = await sessions.findLegacySessionByAccessTokenDigestEntry(
            expected.accessTokenDigest,
        );
        byToken = { value: legacy, expiredEntry: undefined };
    }
    return {
        byToken: byToken.value ?? null,
        bySession: bySession.value ?? null,
        expiredByTokenEntry: byToken.expiredEntry ?? null,
        expiredBySessionEntry: bySession.expiredEntry ?? null,
    };
}
