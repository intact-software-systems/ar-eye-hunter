import type { PSqlTransactionSql } from '@shared-server/postgres/PostgresSqlClient.ts';
import { PSqlRuntimeStateRepository } from '@shared-server/postgres/runtime-state/PSqlRuntimeStateRepository.ts';
import { requireConditionalWrite } from '@shared-server/runtime-state/optimistic-runtime-state-write.ts';
import { AuthSessionRepository } from '../../persistence/auth-session-repository.ts';
import { AuthUserRepository } from '../../persistence/auth-user-repository.ts';
import type { AuthMutationComputed, AuthMutationResult } from '../auth-mutation-contracts.ts';
import { writeAuthLogout, writeAuthSessionIssue } from './write-auth-session.ts';
import { writeAuthTicketMutation } from './write-auth-ticket-mutation.ts';

export async function writeAuthMutation(
    transaction: PSqlTransactionSql,
    computed: AuthMutationComputed
): Promise<AuthMutationResult> {
    if (computed.outcome !== 'write') {
        return computed.result;
    }
    const runtime = new PSqlRuntimeStateRepository(transaction);
    const users = new AuthUserRepository(runtime);
    const sessions = new AuthSessionRepository(runtime);
    switch (computed.command.kind) {
        case 'register-user':
            await writeAuthUserRegistration(users, computed);
            break;
        case 'issue-session':
            await writeAuthSessionIssue(sessions, computed);
            break;
        case 'logout-session':
            await writeAuthLogout(transaction, sessions, computed);
            break;
        case 'issue-ws-ticket':
        case 'consume-ws-ticket':
        case 'issue-agent-tickets':
        case 'consume-agent-ticket':
            await writeAuthTicketMutation(sessions, computed);
            break;
    }
    return computed.result;
}

async function writeAuthUserRegistration(
    users: AuthUserRepository,
    computed: AuthMutationComputed
): Promise<void> {
    const command = computed.command as Extract<AuthMutationComputed['command'], { kind: 'register-user'; }>;
    requireConditionalWrite(await users.insertByNormalizedUsername(command.user));
    requireConditionalWrite(await users.insertByClientId(command.user));
}
