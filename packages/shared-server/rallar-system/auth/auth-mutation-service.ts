import type { PSqlTransactionSql } from '../../postgres/PostgresSqlClient.ts';
import type * as RuntimeState from '../../runtime-state/RuntimeStateRepository.ts';
import { AuthSessionRepository } from '../repositories/AuthSessionRepository.ts';
import { AuthUserRepository } from '../repositories/AuthUserRepository.ts';
import type {
  AuthMutationCommand,
  AuthMutationComputed,
  AuthMutationFacts,
  AuthMutationRead,
  AuthMutationResult,
} from './mutation/auth-mutation-contracts.ts';
import { computeAuthMutation } from './mutation/compute/compute-auth-mutation.ts';
import { readAuthMutation } from '../services/auth-state-read.ts';
import { validateAuthMutation } from '../services/auth-state-validate.ts';
import { writeAuthMutation } from '../services/auth-state-write.ts';

export interface AuthMutationService {
  readonly read: (command: AuthMutationCommand) => Promise<AuthMutationRead>;
  readonly compute: (
    command: AuthMutationCommand,
    read: AuthMutationRead,
    facts: AuthMutationFacts,
  ) => AuthMutationComputed;
  readonly validate: (
    command: AuthMutationCommand,
    read: AuthMutationRead,
    computed: AuthMutationComputed,
  ) => void;
  readonly write: (
    transaction: PSqlTransactionSql,
    computed: AuthMutationComputed,
  ) => Promise<AuthMutationResult>;
}

interface CreateAuthMutationServiceInput {
  readonly runtimeRepository: RuntimeState.RuntimeStateOptimisticTransactionalRepositoryLike;
  readonly serviceId: string;
}

export function createAuthMutationService(
  input: CreateAuthMutationServiceInput,
): AuthMutationService {
  const users = new AuthUserRepository(input.runtimeRepository);
  const sessions = new AuthSessionRepository(input.runtimeRepository);
  return {
    read: async (command) => await readAuthMutation(users, sessions, command),
    compute: (command, read, facts) =>
      computeAuthMutation({ command, read, facts, serviceId: input.serviceId }),
    validate: validateAuthMutation,
    write: async (transaction, computed) => await writeAuthMutation(transaction, computed),
  };
}
