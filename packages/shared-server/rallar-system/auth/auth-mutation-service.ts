import type { PSqlSql } from '../../postgres/p-sql-sql.ts';
import type * as RuntimeState from '../../runtime-state/runtime-state-repository.ts';
import type {
    AuthMutationCommand,
    AuthMutationComputed,
    AuthMutationFacts,
    AuthMutationRead,
    AuthMutationResult
} from './mutation/auth-mutation-contracts.ts';
import { computeAuthMutation } from './mutation/compute/compute-auth-mutation.ts';
import { readAuthMutation } from './mutation/read/read-auth-mutation.ts';
import type { AuthMutationValidationIssue } from './mutation/validate/auth-mutation-validation.ts';
import {
    assertAuthRuntimeStateAuthority,
    assertMatchingAuthKind
} from './mutation/validate/auth-mutation-validation.ts';
import {
    validateAuthMutation,
    type ValidateAuthMutationInput
} from './mutation/validate/validate-auth-mutation.ts';
import { writeAuthMutation } from './mutation/write-auth-mutation.ts';
import { AuthSessionRepository } from './persistence/auth-session-repository.ts';
import { AuthUserRepository } from './persistence/auth-user-repository.ts';

export interface AuthMutationService {
    readonly serviceId: string;
    readonly read: (command: AuthMutationCommand) => Promise<AuthMutationRead>;
    readonly compute: (
        command: AuthMutationCommand,
        read: AuthMutationRead,
        facts: AuthMutationFacts
    ) => AuthMutationComputed;
    readonly validate: (input: ValidateAuthMutationInput) => readonly AuthMutationValidationIssue[];
    readonly write: (
        transaction: PSqlSql,
        computed: AuthMutationComputed
    ) => Promise<AuthMutationResult>;
}

interface CreateAuthMutationServiceInput {
    readonly runtimeRepository: RuntimeState.RuntimeStateOptimisticTransactionalRepositoryLike;
    readonly serviceId: string;
}

export function createAuthMutationService(
    input: CreateAuthMutationServiceInput
): AuthMutationService {
    const users = new AuthUserRepository(input.runtimeRepository);
    const sessions = new AuthSessionRepository(input.runtimeRepository);
    return {
        serviceId: input.serviceId,
        read: async (command) => {
            const read = await readAuthMutation(users, sessions, command);
            assertMatchingAuthKind(command, read);
            assertAuthRuntimeStateAuthority(command, read);
            return read;
        },
        compute: (command, read, facts) => computeAuthMutation({ command, read, facts }),
        validate: validateAuthMutation,
        write: async (transaction, computed) => await writeAuthMutation(transaction, computed)
    };
}
