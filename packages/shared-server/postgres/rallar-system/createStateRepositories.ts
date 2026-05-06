import { AuthSessionRepository } from '@shared-server/rallar-system/repositories/AuthSessionRepository.ts';
import { AuthUserRepository } from '@shared-server/rallar-system/repositories/AuthUserRepository.ts';
import { ClientStateRepository } from '@shared-server/rallar-system/repositories/ClientStateRepository.ts';
import { GroupStateRepository } from '@shared-server/rallar-system/repositories/GroupStateRepository.ts';
import type { RuntimeStateRepositoryLike } from '@shared-server/runtime-state/RuntimeStateRepository.ts';
import type { PSqlSql } from '../PostgresSqlClient.ts';
import { PSqlRuntimeStateRepository } from '../runtime-state/PSqlRuntimeStateRepository.ts';

export function createRuntimeStateRepository(
    sql: PSqlSql,
): PSqlRuntimeStateRepository {
    return new PSqlRuntimeStateRepository(sql);
}

export function createClientStateRepository(
    input: RuntimeStateRepositoryLike | PSqlSql,
): ClientStateRepository {
    return new ClientStateRepository(toRuntimeStateRepository(input));
}

export function createAuthSessionRepository(
    input: RuntimeStateRepositoryLike | PSqlSql,
): AuthSessionRepository {
    return new AuthSessionRepository(toRuntimeStateRepository(input));
}

export function createAuthUserRepository(
    input: RuntimeStateRepositoryLike | PSqlSql,
): AuthUserRepository {
    return new AuthUserRepository(toRuntimeStateRepository(input));
}

export function createGroupStateRepository(
    input: RuntimeStateRepositoryLike | PSqlSql,
): GroupStateRepository {
    return new GroupStateRepository(toRuntimeStateRepository(input));
}

function toRuntimeStateRepository(input: RuntimeStateRepositoryLike | PSqlSql): RuntimeStateRepositoryLike {
    if (isRuntimeStateRepositoryLike(input)) {
        return input;
    }

    return createRuntimeStateRepository(input);
}

function isRuntimeStateRepositoryLike(input: RuntimeStateRepositoryLike | PSqlSql): input is RuntimeStateRepositoryLike {
    return typeof (input as RuntimeStateRepositoryLike).findEntry === 'function';
}
