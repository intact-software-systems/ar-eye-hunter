import type { Sql } from 'postgres';
import { sql as defaultSql } from '../db/db.ts';
import { AuthSessionRepository } from './AuthSessionRepository.ts';
import { RuntimeStateRepository } from './RuntimeStateRepository.ts';
import { ClientStateRepository } from './ClientStateRepository.ts';
import { GroupStateRepository } from './GroupStateRepository.ts';
import { AuthUserRepository } from './AuthUserRepository.ts';

export function createRuntimeStateRepository(
    sql: Sql = defaultSql as unknown as Sql,
): RuntimeStateRepository {
    return new RuntimeStateRepository(sql);
}

export function createClientStateRepository(
    sql: Sql = defaultSql as unknown as Sql,
): ClientStateRepository {
    return new ClientStateRepository(createRuntimeStateRepository(sql));
}

export function createAuthSessionRepository(
    input: RuntimeStateRepository | Sql = defaultSql as unknown as Sql,
): AuthSessionRepository {
    if (input instanceof RuntimeStateRepository) {
        return new AuthSessionRepository(input);
    }

    return new AuthSessionRepository(createRuntimeStateRepository(input));
}

export function createAuthUserRepository(
    input: RuntimeStateRepository | Sql = defaultSql as unknown as Sql,
): AuthUserRepository {
    if (input instanceof RuntimeStateRepository) {
        return new AuthUserRepository(input);
    }

    return new AuthUserRepository(createRuntimeStateRepository(input));
}

export function createGroupStateRepository(
    sql: Sql = defaultSql as unknown as Sql,
): GroupStateRepository {
    return new GroupStateRepository(createRuntimeStateRepository(sql));
}
