import type { PSqlTransactionSql } from '../../postgres/PostgresSqlClient.ts';
import { ResourceInboxRepository } from '../../postgres/resource-inbox/ResourceInboxRepository.ts';
import { PSqlRuntimeStateRepository } from '../../postgres/runtime-state/PSqlRuntimeStateRepository.ts';
import { requireConditionalWrite } from '../../runtime-state/optimistic-runtime-state-write.ts';
import { AuthSessionRepository } from '../repositories/AuthSessionRepository.ts';
import { AuthUserRepository } from '../repositories/AuthUserRepository.ts';
import type {
    AuthComputedSession,
    AuthMutationComputed,
    AuthMutationRead,
    AuthMutationResult,
} from './auth-state-contracts.ts';
import { requireAuthTicket } from './auth-state-validation-shared.ts';
import { requireIssueSessionLifecycle } from './auth-session-lifecycle.ts';

export async function writeAuthMutation(
    transaction: PSqlTransactionSql,
    computed: AuthMutationComputed,
): Promise<AuthMutationResult> {
    if (computed.outcome !== 'write') return computed.result;
    const runtime = new PSqlRuntimeStateRepository(transaction);
    const users = new AuthUserRepository(runtime);
    const sessions = new AuthSessionRepository(runtime);
    switch (computed.command.kind) {
        case 'register-user':
            requireConditionalWrite(
                await users.insertByNormalizedUsername(
                    computed.command.user,
                ),
            );
            requireConditionalWrite(await users.insertByClientId(computed.command.user));
            break;
        case 'issue-session':
            requireIssueSessionLifecycle(
                computed.command.capturedAtEpochMs,
                computed.sessions[0].session,
            );
            await writeSession(sessions, computed.sessions[0]);
            break;
        case 'logout-session': {
            const read = computed.read as Extract<
                AuthMutationRead,
                { kind: 'logout-session' }
            >;
            if (!read.bySession || !read.byToken) break;
            requireConditionalWrite(
                await sessions.deleteSessionBySessionIdIfRevision(
                    computed.command.expected.sessionId,
                    read.bySession.entry.revision,
                ),
            );
            requireConditionalWrite(
                await sessions.deleteSessionTokenStorageKeyIfRevision(
                    read.byToken.entry.key,
                    read.byToken.entry.revision,
                ),
            );
            if (computed.logoutOutbox) {
                await new ResourceInboxRepository(transaction).writeIfAbsentOrMatch(
                    computed.logoutOutbox,
                );
            }
            break;
        }
        case 'issue-ws-ticket':
            requireConditionalWrite(
                await sessions.insertWebSocketTicket(
                    computed.command.ticketRecord,
                ),
            );
            break;
        case 'consume-ws-ticket': {
            const read = computed.read as Extract<
                AuthMutationRead,
                { kind: 'consume-ws-ticket' }
            >;
            const ticket = requireAuthTicket(read.ticket);
            requireConditionalWrite(
                await sessions.deleteWebSocketTicketStorageKeyIfRevision(
                    ticket.entry.key,
                    ticket.entry.revision,
                ),
            );
            break;
        }
        case 'issue-agent-tickets':
            for (let index = 0; index < computed.sessions.length; index += 1) {
                await writeSession(sessions, computed.sessions[index]);
                requireConditionalWrite(
                    await sessions.insertAgentSessionTicket(
                        computed.agentTickets[index],
                    ),
                );
            }
            break;
        case 'consume-agent-ticket': {
            const read = computed.read as Extract<
                AuthMutationRead,
                { kind: 'consume-agent-ticket' }
            >;
            const ticket = requireAuthTicket(read.ticket);
            requireConditionalWrite(
                await sessions.deleteAgentSessionTicketStorageKeyIfRevision(
                    ticket.entry.key,
                    ticket.entry.revision,
                ),
            );
            break;
        }
    }
    return computed.result;
}

async function writeSession(
    repository: AuthSessionRepository,
    computed: AuthComputedSession,
): Promise<void> {
    requireConditionalWrite(await repository.insertSessionByTokenDigest(computed.session));
    requireConditionalWrite(await repository.insertSessionBySessionId(computed.session));
}
