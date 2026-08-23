import type { PSqlSql } from '@shared-server/postgres/PostgresSqlClient.ts';

import {
    decodeClientPrincipalStorageKey,
    decodeClientSessionStorageKey
} from '@shared-server/rallar-system/client-state/persistence/client-state-storage-keys.ts';
import {
    decodeGroupStateGroupStorageKey,
    decodeGroupStateMemberStorageKey,
    decodeGroupStatePresenceSessionStorageKey
} from '@shared-server/rallar-system/group-state/persistence/group-state-storage-keys.ts';
import type { JsonWireValue } from '@shared-server/rallar-system/protocol/json-wire-identity.ts';
import { createTestGroup } from '../../../../packages/tests/create-test-group.ts';
import { createApiV1SqlClient } from '../../src/db/db.ts';
import type { PGliteSql } from '../../src/db/pglite-sql-adapter.ts';

type PSqlValues = Parameters<PSqlSql>[0];

export async function seedAdminOperationsRows(sql: PGliteSql): Promise<void> {
    await sql`
    insert into resource_inbox (
      ri_resource_id, ri_topic_id, ri_resource, ri_type_id, ri_status,
      fk_ext_bank_id, system_date, created_by, created_ts, start_ts, expire_ts
    )
    values
      (${'ri-1'}, ${'topic-1'}, ${'payload'}, ${'WS_INBOX'}, ${'PENDING'},
       ${'bank-1'}, ${'2026-07-08'}, ${'test'}, ${new Date('2026-07-08T10:00:00Z')},
       ${null}, ${new Date('9999-12-31T23:59:59Z')}),
      (${'ri-2'}, ${'topic-2'}, ${'payload'}, ${'WS_OUTBOX'}, ${'RESERVED'},
       ${'bank-2'}, ${'2026-07-08'}, ${'test'}, ${new Date('2026-07-08T10:00:00Z')},
       ${new Date('2026-07-08T10:01:00Z')}, ${new Date('2000-01-01T00:00:00Z')}),
      (${'ri-3'}, ${'app-outbox.rtc-topology'}, ${'payload'}, ${'APP_OUTBOX'}, ${'PENDING'},
       ${'bank-3'}, ${'2026-07-08'}, ${'test'}, ${new Date('2026-07-08T10:00:00Z')},
       ${null}, ${new Date('9999-12-31T23:59:59Z')})
  `;

    await sql`
    insert into resource_inbox_results (
      ris_resource_id, ris_topic_id, ris_resource, ris_type_id, ris_status,
      fk_ext_bank_id, system_date, created_by, created_ts, expire_ts
    )
    values
      (${'ris-1'}, ${'topic-1'}, ${'payload'}, ${'APP_INBOX'}, ${'COMPLETED'},
       ${'bank-1'}, ${'2026-07-08'}, ${'test'}, ${new Date('2026-07-08T10:00:00Z')},
       ${new Date('9999-12-31T23:59:59Z')}),
      (${'ris-2'}, ${'topic-2'}, ${'payload'}, ${'APP_INBOX'}, ${'FAILED'},
       ${'bank-2'}, ${'2026-07-08'}, ${'test'}, ${new Date('2026-07-08T10:00:00Z')},
       ${new Date('2000-01-01T00:00:00Z')})
  `;

    for (
        const [namespace, key, value, expireAt] of [
            [
                'client-state:principals',
                'app=app-1:ws=workspace-1:principal=alice',
                { status: 'active' },
                '9999-12-31T23:59:59Z'
            ],
            [
                'client-state:sessions',
                'app=app-1:ws=workspace-1:principal=alice:instance=browser:session=s1',
                {
                    applicationId: 'app-1',
                    workspaceId: 'workspace-1',
                    status: 'active',
                    principalId: 'alice',
                    presenceState: 'online',
                    expiresAtEpochMs: 1_700_000_060_000
                },
                '9999-12-31T23:59:59Z'
            ],
            [
                'client-state:sessions',
                'app=app-1:ws=workspace-1:principal=bob:instance=browser:session=s2',
                { status: 'expired', principalId: 'bob', presenceState: 'offline' },
                '2000-01-01T00:00:00Z'
            ],
            [
                'group-state:groups',
                'app=app-1:ws=workspace-1:group=room-1',
                { status: 'active' },
                '9999-12-31T23:59:59Z'
            ],
            [
                'group-state:members',
                'app=app-1:ws=workspace-1:group=room-1:member=alice',
                {
                    applicationId: 'app-1',
                    workspaceId: 'workspace-1',
                    groupId: 'room-1',
                    status: 'active',
                    principalId: 'alice'
                },
                '9999-12-31T23:59:59Z'
            ],
            [
                'group-state:sessions',
                'app=app-1:ws=workspace-1:group=room-1:session=s1',
                {
                    applicationId: 'app-1',
                    workspaceId: 'workspace-1',
                    groupId: 'room-1',
                    principalId: 'alice',
                    expiresAtEpochMs: 1_700_000_060_000
                },
                '9999-12-31T23:59:59Z'
            ],
            ['admin-test:expired', 'expired-key', {}, '2000-01-01T00:00:00Z']
        ] as const
    ) {
        await insertRuntimeState(sql, {
            namespace,
            key,
            value,
            expireAt
        });
    }

    await sql`
    insert into client_state_events (
      application_id, workspace_key, principal_id, event_id, event_type,
      snapshot_version, occurred_at_epoch_ms, event_json
    )
    values (
      ${'app-1'}, ${'workspace-1'}, ${'alice'}, ${'ce-1'},
      ${'session-connected'}, ${1}, ${1_700_000_000_000}, ${'{}'}
    )
  `;

    await sql`
    insert into group_state_events (
      application_id, workspace_key, group_id, event_id, event_type,
      snapshot_version, occurred_at_epoch_ms, event_json
    )
    values (
      ${'app-1'}, ${'workspace-1'}, ${'room-1'}, ${'ge-1'},
      ${'session-connected'}, ${1}, ${1_700_000_000_000}, ${'{}'}
    )
  `;

    await sql`
    insert into app_data_store (
      app_namespace, store_name, data_key, data_value, expire_at_ts
    )
    values
      (${'app-ns'}, ${'settings'}, ${'active'}, ${'{}'}, ${new Date('9999-12-31T23:59:59Z')}),
      (${'app-ns'}, ${'settings'}, ${'expired'}, ${'{}'}, ${new Date('2000-01-01T00:00:00Z')})
  `;

    await sql`
    insert into crdt_documents (
      document_key, application_id, workspace_id, document_scope, document_type,
      document_id, document_ref, lifecycle, update_count, snapshot_count,
      stored_update_bytes
    )
    values (
      ${'doc-key-1'}, ${'app-1'}, ${'workspace-1'}, ${'room'}, ${'map'},
      ${'doc-1'}, ${'{}'}, ${'active'}, ${3}, ${1}, ${42}
    )
  `;
}

export async function insertResourceInbox(
    sql: PGliteSql,
    input: Readonly<{
        id: string;
        typeId: string;
        status: string;
    }>
): Promise<void> {
    await sql`
    insert into resource_inbox (
      ri_resource_id, ri_topic_id, ri_resource, ri_type_id, ri_status,
      fk_ext_bank_id, system_date, created_by, created_ts, expire_ts
    )
    values (
      ${`ri-${input.id}`},
      ${`topic-${input.id}`},
      ${'payload'},
      ${input.typeId},
      ${input.status},
      ${'bank-1'},
      ${'2026-07-08'},
      ${'test'},
      ${new Date('2026-07-08T10:00:00Z')},
      ${new Date('9999-12-31T23:59:59Z')}
    )
  `;
}

export async function insertResourceInboxResult(
    sql: PGliteSql,
    input: Readonly<{
        id: string;
        typeId: string;
        status: string;
    }>
): Promise<void> {
    await sql`
    insert into resource_inbox_results (
      ris_resource_id, ris_topic_id, ris_resource, ris_type_id, ris_status,
      fk_ext_bank_id, system_date, created_by, created_ts, expire_ts
    )
    values (
      ${`ris-${input.id}`},
      ${`topic-${input.id}`},
      ${'payload'},
      ${input.typeId},
      ${input.status},
      ${'bank-1'},
      ${'2026-07-08'},
      ${'test'},
      ${new Date('2026-07-08T10:00:00Z')},
      ${new Date('9999-12-31T23:59:59Z')}
    )
  `;
}

export async function insertRuntimeState(
    sql: PGliteSql,
    input: Readonly<{
        namespace: string;
        key: string;
        value: object | null | boolean | number | string;
        expireAt?: string;
    }>
): Promise<void> {
    const value = withCanonicalRuntimeIdentity(
        input.namespace,
        input.key,
        input.value
    );
    await sql`
    insert into runtime_state_store (store_namespace, store_key, store_value, expire_at_ts)
    values (
      ${input.namespace},
      ${input.key},
      ${JSON.stringify(value)},
      ${new Date(input.expireAt ?? '9999-12-31T23:59:59Z')}
    )
  `;
}

export async function insertRawRuntimeState(
    sql: PGliteSql,
    input: Readonly<{
        namespace: string;
        key: string;
        value: object | null | boolean | number | string;
        expireAt?: string;
    }>
): Promise<void> {
    await sql`
    insert into runtime_state_store (store_namespace, store_key, store_value, expire_at_ts)
    values (
      ${input.namespace},
      ${input.key},
      ${JSON.stringify(toJsonWireValue(input.value))},
      ${new Date(input.expireAt ?? '9999-12-31T23:59:59Z')}
    )
  `;
}

const CANONICAL_AUDIT = Object.freeze({
    atEpochMs: 1_700_000_000_000,
    actor: Object.freeze({
        kind: 'principal',
        principalId: 'admin-test-owner'
    }),
    reason: null,
    traceId: null,
    requestId: 'admin-test-request'
});

export function canonicalGroupRuntimeValue(
    key: string,
    overrides: Readonly<Record<string, JsonWireValue>> = {}
): Record<string, JsonWireValue> {
    const identity = decodeGroupStateGroupStorageKey(key);
    const value = readJsonRecord(toJsonWireValue({
        ...createTestGroup({
            ...identity,
            displayName: identity.groupId,
            activeMemberCount: 1,
            ownerPrincipalId: 'admin-test-owner',
            snapshotVersion: 1,
            metadataVersion: 1,
            rosterVersion: 1,
            presenceVersion: 0,
            created: CANONICAL_AUDIT,
            updated: CANONICAL_AUDIT
        }),
        ...overrides
    }));
    if (value.status === 'archived' && !Object.hasOwn(overrides, 'archived')) {
        value.archived = CANONICAL_AUDIT;
    }
    if (value.status === 'deleted' && !Object.hasOwn(overrides, 'deleted')) {
        value.deleted = CANONICAL_AUDIT;
    }
    return value;
}

export function canonicalMemberRuntimeValue(
    key: string,
    overrides: Readonly<Record<string, JsonWireValue>> = {}
): Record<string, JsonWireValue> {
    const value: Record<string, JsonWireValue> = {
        ...decodeGroupStateMemberStorageKey(key),
        role: 'member',
        status: 'active',
        joined: CANONICAL_AUDIT,
        updated: CANONICAL_AUDIT,
        left: null,
        removed: null,
        banned: null,
        invitedByPrincipalId: null,
        invitationExpiresAtEpochMs: null,
        ...overrides
    };
    if (value.status === 'invited' && !Object.hasOwn(overrides, 'joined')) {
        value.joined = null;
    }
    if (value.status === 'left' && !Object.hasOwn(overrides, 'left')) {
        value.left = CANONICAL_AUDIT;
    }
    if (value.status === 'removed' && !Object.hasOwn(overrides, 'removed')) {
        value.removed = CANONICAL_AUDIT;
    }
    if (value.status === 'banned' && !Object.hasOwn(overrides, 'banned')) {
        value.banned = CANONICAL_AUDIT;
    }
    return value;
}

export function canonicalSessionRuntimeValue(
    key: string,
    overrides: Readonly<Record<string, JsonWireValue>> = {}
): Record<string, JsonWireValue> {
    const identity = decodeGroupStatePresenceSessionStorageKey(key);
    const requestedExpiry = overrides.expiresAtEpochMs;
    const connectedAtEpochMs = typeof requestedExpiry === 'number' && requestedExpiry > 1_000
        ? Math.min(1_700_000_000_000, requestedExpiry - 1_000)
        : 1_700_000_000_000;
    const value: Record<string, JsonWireValue> = {
        ...identity,
        principalId: 'admin-test-owner',
        generationId: `${identity.sessionId}-generation`,
        generationVersion: connectedAtEpochMs,
        status: 'active',
        connectedAtEpochMs,
        lastHeartbeatAtEpochMs: connectedAtEpochMs,
        expiresAtEpochMs: connectedAtEpochMs + 60_000,
        disconnectedAtEpochMs: null,
        disconnectReason: null,
        ...overrides
    };
    if (
        value.disconnectedAtEpochMs !== null &&
        !Object.hasOwn(overrides, 'status')
    ) {
        value.status = 'disconnected';
    }
    if (
        value.disconnectedAtEpochMs !== null &&
        !Object.hasOwn(overrides, 'disconnectReason')
    ) {
        value.disconnectReason = 'admin-test-disconnect';
    }
    return value;
}

function withCanonicalRuntimeIdentity<Value>(
    namespace: string,
    key: string,
    value: Value
): JsonWireValue {
    const normalized = toJsonWireValue(value);
    if (!isJsonRecord(normalized)) {
        return normalized;
    }
    const overrides = normalized;
    try {
        if (namespace === 'client-state:principals') {
            return { ...decodeClientPrincipalStorageKey(key), ...overrides };
        }
        if (namespace === 'client-state:sessions') {
            return { ...decodeClientSessionStorageKey(key), ...overrides };
        }
    }
    catch {
        return normalized;
    }
    return namespace === 'group-state:groups'
        ? canonicalGroupRuntimeValue(key, overrides)
        : namespace === 'group-state:members'
        ? canonicalMemberRuntimeValue(key, overrides)
        : namespace === 'group-state:sessions'
        ? canonicalSessionRuntimeValue(key, overrides)
        : normalized;
}

function toJsonWireValue<Value>(value: Value): JsonWireValue {
    return JSON.parse(JSON.stringify(value));
}

function readJsonRecord(value: JsonWireValue): Record<string, JsonWireValue> {
    if (!isJsonRecord(value)) {
        throw new TypeError('Expected JSON object fixture');
    }
    return { ...value };
}

function isJsonRecord(
    value: JsonWireValue
): value is Readonly<Record<string, JsonWireValue>> {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function createRuntimeJsonScanGuard(
    sql: PGliteSql
): Readonly<{ guardedSql: PSqlSql; runtimeJsonScanCount: number; }> {
    let runtimeJsonScanCount = 0;
    const guarded = ((
        stringsOrValues: TemplateStringsArray | PSqlValues,
        ...values: PSqlValues
    ) => {
        if ('raw' in stringsOrValues) {
            const queryText = Array.from(stringsOrValues).join('?').toLowerCase();
            if (
                queryText.includes('select store_key, store_value') &&
                queryText.includes('from runtime_state_store') &&
                values.some(
                    (value) => typeof value === 'string' && value.startsWith('group-state:')
                )
            ) {
                runtimeJsonScanCount += 1;
            }
            return sql(stringsOrValues, ...values);
        }
        return sql(stringsOrValues);
    }) as PSqlSql;
    guarded.begin = sql.begin;
    return {
        guardedSql: guarded,
        get runtimeJsonScanCount() {
            return runtimeJsonScanCount;
        }
    };
}

export function createAdminSession() {
    return {
        clientId: 'platform-admin',
        username: 'admin',
        accessToken: 'access-token',
        sessionId: 'admin-session',
        expiresAtEpochMs: 1_700_000_060_000
    };
}

export async function withPGliteSql(
    fn: (sql: PGliteSql) => Promise<void>
): Promise<void> {
    const sql = createApiV1SqlClient({ sqlBackend: 'pglite-memory' }) as PGliteSql;
    try {
        await fn(sql);
    }
    finally {
        await sql.close();
    }
}
