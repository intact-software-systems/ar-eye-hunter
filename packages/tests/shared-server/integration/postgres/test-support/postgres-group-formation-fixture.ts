import type { PSqlSql } from '@shared-server/postgres/p-sql-sql.ts';
import { AppInboxType } from '@shared-server/rallar-system/app-inbox/app-inbox-contracts.ts';
import type { AppInboxFailure } from '@shared-server/rallar-system/app-inbox/app-inbox-failure.ts';
import { GROUP_STATE_APP_INBOX_TOPIC } from '@shared-server/rallar-system/app-inbox/app-inbox-topics.ts';
import type { AuthenticatedGroupMutationEnqueue } from '@shared-server/rallar-system/group-state/inbox/group-state-inbox-contracts.ts';
import type { GroupStateInboxDurableResult } from '@shared-server/rallar-system/group-state/inbox/group-state-inbox-result.ts';
import type { GroupMutationReceipt } from '@shared-server/rallar-system/group-state/mutation/group-mutation-contracts.ts';
import { GroupStateRepository } from '@shared-server/rallar-system/group-state/persistence/group-state-repository.ts';
import { PSqlGroupStateEventRepository } from '@shared-server/rallar-system/state-events/postgres/p-sql-group-state-event-repository.ts';
import { PSqlRuntimeStateRepository } from '@shared-server/runtime-state/postgres/p-sql-runtime-state-repository.ts';
import { EnqueuedType } from '@shared/api/api-config.ts';
import type { GroupRef } from '@shared/api/group-types.ts';
import type { StateScope } from '@shared/api/state-types.ts';
import { toAppQueueKey } from '@shared/queuebox/AppQueueIdentity.ts';
import type { Key } from '@shared/queuebox/ResourceEntry.ts';
import type { Either } from '@shared/resilience/Either.ts';

import { createTestGroupStateRuntime } from '../../../rallar-system/group-state/group-state-test-runtime.ts';
import type { PostgresAppInboxWorkerRuntime } from './postgres-app-inbox-worker-runtime.ts';
import {
    createPostgresAppInboxTestAuthority,
    toAuthenticatedGroupAppInboxEnqueue,
    toGroupAppInboxStorageCommandId,
    type GroupAppInboxMutationInput
} from './postgres-group-app-inbox-mutation.ts';

export type GroupFormationCommandResult = Either<AppInboxFailure, GroupStateInboxDurableResult>;

export interface GroupFormationFixture {
    readonly groupRef: GroupRef;
    readonly repository: GroupStateRepository;
    readonly atEpochMs: number;
}

export interface SeedGroupFormationInput {
    readonly sql: PSqlSql;
    readonly scope: StateScope;
    readonly activeMemberIds: readonly string[];
    readonly atEpochMs: number;
    readonly requestIdFor: (semanticId: string) => string;
}

/** An open group owned by alice whose active members are already in it. */
export async function seedGroupFormation(input: SeedGroupFormationInput): Promise<GroupFormationFixture> {
    const groupRef: GroupRef = { ...input.scope, groupId: 'room-1' };
    const runtimeRepository = new PSqlRuntimeStateRepository(input.sql);
    const setup = createTestGroupStateRuntime({
        runtimeRepository,
        groupStateEventStoreFor: () => new PSqlGroupStateEventRepository(input.sql),
        now: () => input.atEpochMs,
        serviceId: 'postgres-group-formation-setup'
    }).service;
    await setup.createGroup(input.scope, {
        groupId: groupRef.groupId,
        displayName: 'Group formation',
        kind: 'room',
        joinMode: 'open',
        maxMembers: 8,
        createdByPrincipalId: 'alice',
        actorPrincipalId: 'alice',
        actorSessionId: 'alice-session',
        requestId: input.requestIdFor('formation-create')
    });
    for (const principalId of input.activeMemberIds) {
        await setup.upsertMember(input.scope, groupRef.groupId, principalId, {
            status: 'active',
            actorPrincipalId: principalId,
            actorSessionId: `${principalId}-session`,
            requestId: input.requestIdFor(`formation-member-${principalId}`)
        });
    }
    return {
        groupRef,
        repository: new GroupStateRepository(runtimeRepository, new PSqlGroupStateEventRepository(input.sql)),
        atEpochMs: input.atEpochMs
    };
}

export interface GroupFormationCommand {
    readonly input: GroupAppInboxMutationInput;
    readonly enqueue: AuthenticatedGroupMutationEnqueue;
    /** The physical row key the group AppInbox writer gives this command. */
    readonly queueKey: Key;
}

interface GroupFormationCommandInput {
    readonly runtime: PostgresAppInboxWorkerRuntime;
    readonly fixture: GroupFormationFixture;
    readonly principalId: string;
    readonly requestId: string;
}

export function toJoinCommand(input: GroupFormationCommandInput): GroupFormationCommand {
    const sessionId = `${input.principalId}-session`;
    return toCallerCommand({
        runtime: input.runtime,
        authority: createPostgresAppInboxTestAuthority(input.principalId, sessionId),
        type: AppInboxType.GROUP_JOIN,
        data: {
            scope: toScope(input.fixture.groupRef),
            groupId: input.fixture.groupRef.groupId,
            request: { actorPrincipalId: input.principalId, actorSessionId: sessionId, requestId: input.requestId }
        }
    });
}

/** The owner, alice, removes the member. */
export function toRemoveMemberCommand(input: GroupFormationCommandInput): GroupFormationCommand {
    return toCallerCommand({
        runtime: input.runtime,
        authority: createPostgresAppInboxTestAuthority('alice', 'alice-session'),
        type: AppInboxType.GROUP_MEMBER_REMOVE,
        data: {
            scope: toScope(input.fixture.groupRef),
            groupId: input.fixture.groupRef.groupId,
            principalId: input.principalId,
            request: { actorPrincipalId: 'alice', actorSessionId: 'alice-session', requestId: input.requestId }
        }
    });
}

/** A connect from the member's own presence session, the session the AppInbox keys it by. */
export function toConnectCommand(input: GroupFormationCommandInput): GroupFormationCommand {
    const sessionId = toPresenceSessionId(input.principalId);
    const connectedAtEpochMs = input.fixture.atEpochMs + 1_000;
    return toCallerCommand({
        runtime: input.runtime,
        authority: createPostgresAppInboxTestAuthority(input.principalId, sessionId),
        type: AppInboxType.GROUP_PRESENCE_CONNECT,
        data: {
            scope: toScope(input.fixture.groupRef),
            groupId: input.fixture.groupRef.groupId,
            sessionId,
            request: {
                principalId: input.principalId,
                generationId: `${sessionId}-generation`,
                connectionGenerationId: `${sessionId}-ws-generation`,
                connectedAtEpochMs,
                lastHeartbeatAtEpochMs: connectedAtEpochMs,
                expiresAtEpochMs: connectedAtEpochMs + 60_000,
                actorPrincipalId: input.principalId,
                actorSessionId: sessionId,
                requestId: input.requestId
            }
        }
    });
}

export function toPresenceSessionId(principalId: string): string {
    return `${principalId}-presence`;
}

/** The API server claims a caller's command in that caller's own context, so one round can take several of them. */
function toCallerCommand(input: GroupAppInboxMutationInput): GroupFormationCommand {
    const authenticated = toAuthenticatedGroupAppInboxEnqueue(input);
    const enqueue = { ...authenticated, contextId: `${authenticated.contextId}:caller=${encodeURIComponent(input.authority.clientId)}` };
    return {
        input,
        enqueue,
        queueKey: toAppQueueKey({
            topicId: GROUP_STATE_APP_INBOX_TOPIC,
            resourceId: input.data.request.requestId,
            contextId: enqueue.contextId
        })
    };
}

export interface QueuedGroupFormationCommand {
    /** Settles once a worker completes the command; nothing claims it until a worker runs a pass. */
    readonly result: Promise<GroupFormationCommandResult>;
}

/** Puts the caller's session and enqueues the command, resolving once its row is queued. */
export async function enqueueGroupFormationCommand(
    sql: PSqlSql,
    command: GroupFormationCommand
): Promise<QueuedGroupFormationCommand> {
    await command.input.runtime.authSessions.putSession(command.input.authority);
    const result = command.input.runtime.group.processAuthenticatedGroupEntryUntilCompletion(
        command.enqueue,
        command.input.authority
    );
    result.catch(() => undefined);
    await waitForAppInboxRow(sql, command.queueKey);
    return { result };
}

export async function readGroupFormationReceipt(
    fixture: GroupFormationFixture,
    command: GroupFormationCommand
): Promise<GroupMutationReceipt> {
    const record = await fixture.repository.findIdempotentGroupMutationReceipt(
        fixture.groupRef,
        toGroupAppInboxStorageCommandId(command.enqueue, command.input.authority.clientId)
    );
    if (!record) {
        throw new Error(`Group formation receipt not found: ${command.enqueue.resourceId}`);
    }
    return record.receipt;
}

export interface AppInboxRowState {
    readonly status: string;
    readonly attempts: number;
    /** Whether the stored result a waiting caller reads has been written. */
    readonly hasResult: boolean;
}

export async function readAppInboxRowState(sql: PSqlSql, key: Key): Promise<AppInboxRowState | undefined> {
    const rows = await sql<{ ri_status: string; ri_attempts: number; has_result: boolean; }[]>`
        select ri_status, ri_attempts,
            exists (
                select 1 from resource_inbox_results
                where ris_topic_id = ${key.topicId} and ris_resource_id = ${key.resourceId} and fk_ext_bank_id = ${key.contextId}
            ) as has_result
        from resource_inbox
        where ri_topic_id = ${key.topicId} and ri_resource_id = ${key.resourceId} and fk_ext_bank_id = ${key.contextId}
    `;
    const row = rows[0];
    return row ? { status: row.ri_status, attempts: Number(row.ri_attempts), hasResult: row.has_result } : undefined;
}

async function waitForAppInboxRow(sql: PSqlSql, key: Key): Promise<void> {
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline) {
        if (await readAppInboxRowState(sql, key)) {
            return;
        }
        await new Promise((resolve) => setTimeout(resolve, 5));
    }
    throw new Error(`AppInbox row was never queued: ${key.resourceId}`);
}

/** Removes the AppInbox and AppOutbox rows, and their stored results, of one test-owned application. */
export async function deleteApplicationQueueRows(sql: PSqlSql, applicationId: string): Promise<void> {
    await sql`
        with deleted as (
            delete from resource_inbox
            where ri_type_id in (${EnqueuedType.APP_INBOX}, ${EnqueuedType.APP_OUTBOX})
              and position(${applicationId} in ri_resource) > 0
            returning ri_topic_id, ri_resource_id, fk_ext_bank_id
        )
        delete from resource_inbox_results result
        using deleted
        where result.ris_topic_id = deleted.ri_topic_id
          and result.ris_resource_id = deleted.ri_resource_id
          and result.fk_ext_bank_id = deleted.fk_ext_bank_id
    `;
}

export function requireDefined<T>(value: T | undefined, name: string): T {
    if (value === undefined) {
        throw new Error(`Expected ${name}`);
    }
    return value;
}

function toScope(ref: GroupRef): StateScope {
    return { applicationId: ref.applicationId, workspaceId: ref.workspaceId };
}
