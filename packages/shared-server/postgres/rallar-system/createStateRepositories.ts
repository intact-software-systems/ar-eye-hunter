import { AuthSessionRepository } from '@shared-server/rallar-system/repositories/AuthSessionRepository.ts';
import { AuthUserRepository } from '@shared-server/rallar-system/repositories/AuthUserRepository.ts';
import { ClientStateRepository } from '@shared-server/rallar-system/client-state/persistence/client-state-repository.ts';
// prettier-ignore
import {
    GroupStateRepository,
} from '@shared-server/rallar-system/group-state/persistence/group-state-repository.ts';
import type {
    ClientStateEventStore,
    GroupStateEventStore,
} from '@shared-server/rallar-system/repositories/StateEventStore.ts';
import type { RuntimeStateRepositoryLike } from '@shared-server/runtime-state/RuntimeStateRepository.ts';
import type { PSqlSql } from '../PostgresSqlClient.ts';
import { PSqlRuntimeStateRepository } from '../runtime-state/PSqlRuntimeStateRepository.ts';
import {
    PSqlClientStateEventRepository,
    PSqlGroupStateEventRepository,
} from './PSqlStateEventRepository.ts';

export function createRuntimeStateRepository(
    sql: PSqlSql,
): PSqlRuntimeStateRepository {
    return new PSqlRuntimeStateRepository(sql);
}

export function createClientStateRepository(
    input: RuntimeStateRepositoryLike | PSqlSql,
): ClientStateRepository {
    const runtimeRepository = toRuntimeStateRepository(input);
    return new ClientStateRepository(runtimeRepository, {
        events: maybeCreateClientStateEventRepository(input),
    });
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
    const runtimeRepository = toRuntimeStateRepository(input);
    return new GroupStateRepository(runtimeRepository, {
        events: maybeCreateGroupStateEventRepository(input),
    });
}

export function createClientStateEventRepository(
    input: RuntimeStateRepositoryLike | PSqlSql,
): ClientStateEventStore {
    return new PSqlClientStateEventRepository(toSql(input));
}

export function createGroupStateEventRepository(
    input: RuntimeStateRepositoryLike | PSqlSql,
): GroupStateEventStore {
    return new PSqlGroupStateEventRepository(toSql(input));
}

function toRuntimeStateRepository(input: RuntimeStateRepositoryLike | PSqlSql): RuntimeStateRepositoryLike {
    if (isRuntimeStateRepositoryLike(input)) {
        return input;
    }

    return createRuntimeStateRepository(input);
}

function toSql(input: RuntimeStateRepositoryLike | PSqlSql): PSqlSql {
    if (input instanceof PSqlRuntimeStateRepository) {
        return input.sql;
    }

    if (!isRuntimeStateRepositoryLike(input)) {
        return input;
    }

    throw new Error(
        'A SQL-backed state event repository requires PSqlSql or PSqlRuntimeStateRepository',
    );
}

function maybeCreateClientStateEventRepository(
    input: RuntimeStateRepositoryLike | PSqlSql,
): ClientStateEventStore | undefined {
    return canCreateSqlStateEventRepository(input)
        ? createClientStateEventRepository(input)
        : undefined;
}

function maybeCreateGroupStateEventRepository(
    input: RuntimeStateRepositoryLike | PSqlSql,
): GroupStateEventStore | undefined {
    return canCreateSqlStateEventRepository(input)
        ? createGroupStateEventRepository(input)
        : undefined;
}

function canCreateSqlStateEventRepository(
    input: RuntimeStateRepositoryLike | PSqlSql,
): boolean {
    return input instanceof PSqlRuntimeStateRepository ||
        !isRuntimeStateRepositoryLike(input);
}

function isRuntimeStateRepositoryLike(
    input: RuntimeStateRepositoryLike | PSqlSql,
): input is RuntimeStateRepositoryLike {
    return typeof (input as RuntimeStateRepositoryLike).findEntry === 'function';
}
