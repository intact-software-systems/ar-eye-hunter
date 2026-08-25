import { Temporal } from '@js-temporal/polyfill';
import { hashAuthSecret } from '@shared-server/rallar-system/auth/credentials/hash-auth-secret.ts';
import { type IssuedAuthSession } from '@shared-server/rallar-system/auth/persistence/auth-session-types.ts';
import { type PersistedAuthSession } from '@shared-server/rallar-system/auth/persistence/persisted-auth-session.ts';
import type { JsonWireValue } from '@shared-server/rallar-system/protocol/json-wire-identity.ts';
import { EntityStatus, type ResourceEntry } from '@shared/queuebox/ResourceEntry.ts';
import assert from 'node:assert/strict';
import type { PGliteSql } from '../../src/db/pglite-sql-adapter.ts';
import { createApiV1TestPGliteDatabaseLifecycle } from './api-v1-test-pglite-database.ts';

export const FUTURE_MS = Date.parse('9999-12-31T23:59:59.999Z');
const FUTURE_INSTANT = Temporal.Instant.from('9999-12-31T23:59:59.999Z');
const CREATED_TS = Temporal.PlainDateTime.from('2026-06-01T12:00:00');

export async function withPGliteSql(
    fn: (sql: PGliteSql) => Promise<void>
): Promise<void> {
    const lifecycle = await createApiV1TestPGliteDatabaseLifecycle();
    try {
        await fn(lifecycle.database);
    }
    finally {
        await lifecycle.close();
    }
}

export async function withUtcPGliteSql(
    fn: (sql: PGliteSql) => Promise<void>
): Promise<void> {
    await withPGliteSql(async (sql) => {
        await sql.exec('set time zone \'UTC\'');
        await fn(sql);
    });
}

export async function readPGliteDatabaseEpochMs(sql: PGliteSql): Promise<number> {
    const [clock] = await sql<{ epoch_ms: string | number; }[]>`
    select floor(extract(epoch from now()) * 1000)::bigint as epoch_ms
  `;
    assert.ok(clock);
    return Number(clock.epoch_ms);
}

export async function toPersistedAuthSessionFixture(
    session: IssuedAuthSession
): Promise<PersistedAuthSession> {
    return {
        clientId: session.clientId,
        username: session.username,
        sessionId: session.sessionId,
        accessTokenDigest: await hashAuthSecret(session.accessToken),
        issuedAtEpochMs: session.issuedAtEpochMs,
        expiresAtEpochMs: session.expiresAtEpochMs
    };
}

export function createResourceEntry(
    resourceId: string,
    options: Readonly<{
        topicId?: string;
        contextId?: string;
        typeId?: string;
        status?: EntityStatus;
        payload?: JsonWireValue;
        expiryTs?: Temporal.Instant;
    }> = {}
): ResourceEntry {
    return {
        key: {
            topicId: options.topicId ?? 'topic-smoke',
            resourceId,
            contextId: options.contextId ?? 'ctx-smoke'
        },
        resource: JSON.stringify(options.payload ?? { resourceId }),
        typeId: options.typeId ?? 'TYPE_A',
        status: options.status ?? EntityStatus.NEW,
        audit: {
            date: CREATED_TS.toPlainTime(),
            createdBy: 'tester',
            createdTs: CREATED_TS,
            expiryTs: options.expiryTs ?? FUTURE_INSTANT
        },
        dequeueAudit: { attempts: 0 }
    };
}
