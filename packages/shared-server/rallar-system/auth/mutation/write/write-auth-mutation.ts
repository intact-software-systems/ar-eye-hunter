import type { PSqlSql } from '@shared-server/postgres/p-sql-sql.ts';
import { requireConditionalWrite } from '@shared-server/runtime-state/optimistic-runtime-state-write.ts';
import { PSqlRuntimeStateRepository } from '@shared-server/runtime-state/postgres/p-sql-runtime-state-repository.ts';
import {
    AUTH_USERS_BY_CLIENT_ID_NAMESPACE,
    AUTH_USERS_BY_USERNAME_NAMESPACE
} from '../../persistence/auth-storage-keys.ts';
import type {
    AuthComputedUserRegistration,
    AuthMutationComputed,
    AuthMutationResult
} from '../auth-mutation-contracts.ts';
import { writeAuthLogout, writeAuthSession } from './write-auth-session.ts';
import { writeAuthTicketMutation } from './write-auth-ticket-mutation.ts';

export async function writeAuthMutation(
    transaction: PSqlSql,
    computed: AuthMutationComputed
): Promise<AuthMutationResult> {
    if (computed.outcome !== 'write') {
        return computed.result;
    }
    const runtime = new PSqlRuntimeStateRepository(transaction);
    switch (computed.kind) {
        case 'register-user':
            await writeAuthUserRegistration(runtime, computed.userRegistration);
            break;
        case 'issue-session':
            await writeAuthSession(runtime, computed.sessions[0]);
            break;
        case 'logout-session':
            await writeAuthLogout(transaction, runtime, computed);
            break;
        case 'issue-ws-ticket':
        case 'consume-ws-ticket':
        case 'issue-agent-tickets':
        case 'consume-agent-ticket':
            await writeAuthTicketMutation(runtime, computed);
            break;
    }
    return computed.result;
}

async function writeAuthUserRegistration(
    runtime: PSqlRuntimeStateRepository,
    computed: AuthComputedUserRegistration
): Promise<void> {
    requireConditionalWrite(
        await runtime.insertIfAbsent(
            AUTH_USERS_BY_USERNAME_NAMESPACE,
            computed.usernameStorageKey,
            computed.serializedValue,
            computed.expireAtIsoTimestamp
        )
    );
    requireConditionalWrite(
        await runtime.insertIfAbsent(
            AUTH_USERS_BY_CLIENT_ID_NAMESPACE,
            computed.clientIdStorageKey,
            computed.serializedValue,
            computed.expireAtIsoTimestamp
        )
    );
}
