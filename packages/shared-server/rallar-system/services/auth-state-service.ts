import type {
    RuntimeStateOptimisticTransactionalRepositoryLike,
} from '../../runtime-state/RuntimeStateRepository.ts';
import { AuthSessionRepository } from '../repositories/AuthSessionRepository.ts';
import { AuthUserRepository } from '../repositories/AuthUserRepository.ts';
import { computeAuthMutation } from './auth-state-compute.ts';
import type { AuthMutationService } from './auth-state-contracts.ts';
import { readAuthMutation } from './auth-state-read.ts';
import { validateAuthMutation } from './auth-state-validate.ts';
import { writeAuthMutation } from './auth-state-write.ts';

export function createAuthMutationService(
    options: Readonly<{
        runtimeRepository: RuntimeStateOptimisticTransactionalRepositoryLike;
        serviceId: string;
    }>,
): AuthMutationService {
    const users = new AuthUserRepository(options.runtimeRepository);
    const sessions = new AuthSessionRepository(options.runtimeRepository);
    return {
        read: async (command) => await readAuthMutation(users, sessions, command),
        compute: (command, read, facts) =>
            computeAuthMutation(
                command,
                read,
                facts,
                options.serviceId,
            ),
        validate: validateAuthMutation,
        write: async (transaction, computed) => await writeAuthMutation(transaction, computed),
    };
}
