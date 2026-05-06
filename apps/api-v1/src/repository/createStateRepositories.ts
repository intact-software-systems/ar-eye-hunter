import type { Sql } from 'postgres';
import { AuthSessionRepository } from '@shared-server/rallar-system/repositories/AuthSessionRepository.ts';
import { AuthUserRepository } from '@shared-server/rallar-system/repositories/AuthUserRepository.ts';
import { ClientStateRepository } from '@shared-server/rallar-system/repositories/ClientStateRepository.ts';
import { GroupStateRepository } from '@shared-server/rallar-system/repositories/GroupStateRepository.ts';
import type { RuntimeStateRepositoryLike } from '@shared-server/runtime-state/RuntimeStateRepository.ts';
import type { PSqlSql } from '@shared-server/postgres/PostgresSqlClient.ts';
import {
    createAuthSessionRepository as createSharedAuthSessionRepository,
    createAuthUserRepository as createSharedAuthUserRepository,
    createClientStateRepository as createSharedClientStateRepository,
    createGroupStateRepository as createSharedGroupStateRepository,
    createRuntimeStateRepository as createSharedRuntimeStateRepository,
} from '@shared-server/postgres/rallar-system/createStateRepositories.ts';
import { PSqlRuntimeStateRepository } from '@shared-server/postgres/runtime-state/PSqlRuntimeStateRepository.ts';
import { sql as defaultSql } from '../db/db.ts';

export { PSqlRuntimeStateRepository as RuntimeStateRepository };

export function createRuntimeStateRepository(
    sql: Sql = defaultSql as unknown as Sql,
): PSqlRuntimeStateRepository {
    return createSharedRuntimeStateRepository(sql as unknown as PSqlSql);
}

export function createClientStateRepository(
    input: RuntimeStateRepositoryLike | Sql = defaultSql as unknown as Sql,
): ClientStateRepository {
    return createSharedClientStateRepository(input as RuntimeStateRepositoryLike | PSqlSql);
}

export function createAuthSessionRepository(
    input: RuntimeStateRepositoryLike | Sql = defaultSql as unknown as Sql,
): AuthSessionRepository {
    return createSharedAuthSessionRepository(input as RuntimeStateRepositoryLike | PSqlSql);
}

export function createAuthUserRepository(
    input: RuntimeStateRepositoryLike | Sql = defaultSql as unknown as Sql,
): AuthUserRepository {
    return createSharedAuthUserRepository(input as RuntimeStateRepositoryLike | PSqlSql);
}

export function createGroupStateRepository(
    input: RuntimeStateRepositoryLike | Sql = defaultSql as unknown as Sql,
): GroupStateRepository {
    return createSharedGroupStateRepository(input as RuntimeStateRepositoryLike | PSqlSql);
}
