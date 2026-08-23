import { type IssuedAuthSession } from '@shared-server/rallar-system/auth/persistence/auth-session-types.ts';
import {
    type GroupMutationDescriptor,
    type GroupMutationPreparation,
    type GroupStateService
} from '@shared-server/rallar-system/group-state/group-state-service-contracts.ts';
import type { ClientEvent } from '@shared/api/client-types.ts';
import type { AuditStamp, Group, GroupEvent, GroupRef } from '@shared/api/group-types.ts';
import { createTestGroup } from '../../../../packages/tests/create-test-group.ts';

import type { PGliteSql } from '../../src/db/pglite-sql-adapter.ts';

interface ApplyPGliteGroupMutationInput {
    readonly sql: PGliteSql;
    readonly service: GroupStateService;
    readonly descriptor: GroupMutationDescriptor;
    readonly authority: IssuedAuthSession;
}

interface CreateClientStateEventInput {
    readonly eventId: string;
    readonly occurredAtEpochMs: number;
    readonly snapshotVersion: number;
    readonly eventType?: ClientEvent['eventType'];
    readonly overrides?: Partial<ClientEvent>;
}

interface CreateGroupStateEventInput {
    readonly eventId: string;
    readonly occurredAtEpochMs: number;
    readonly snapshotVersion: number;
    readonly eventType?: GroupEvent['eventType'];
    readonly overrides?: Partial<GroupEvent>;
}

export function groupFixture(ref: GroupRef, displayName: string): Group {
    const audit = canonicalAuditStamp(1);
    return createTestGroup({
        ...ref,
        displayName,
        activeMemberCount: 1,
        ownerPrincipalId: 'alice',
        snapshotVersion: 1,
        metadataVersion: 1,
        rosterVersion: 1,
        presenceVersion: 0,
        created: audit,
        updated: audit
    });
}

export async function applyPGliteGroupMutation(
    input: ApplyPGliteGroupMutationInput
): Promise<void> {
    const { sql, service, descriptor, authority } = input;
    await applyPreparedPGliteGroupMutation(
        sql,
        service,
        await service.prepareMutation(descriptor, authority)
    );
}

export async function applyPreparedPGliteGroupMutation(
    sql: PGliteSql,
    service: GroupStateService,
    preparation: GroupMutationPreparation
): Promise<void> {
    const command = {
        ...preparation,
        facts: { ...preparation.facts, attemptCount: 1 }
    };
    const read = await service.read(command);
    const computed = service.compute(command, read);
    service.validate(command, read, computed);
    if (computed.outcome !== 'write') {
        return;
    }
    await sql.begin(async (transaction) => {
        await service.write(transaction, computed);
    });
}

export function createClientStateEvent(input: CreateClientStateEventInput): ClientEvent {
    const {
        eventId,
        occurredAtEpochMs,
        snapshotVersion,
        eventType = 'session-connected',
        overrides = {}
    } = input;
    return {
        applicationId: 'rallar-test',
        workspaceId: 'main',
        principalId: 'principal-1',
        eventId,
        eventType,
        snapshotVersion,
        occurredAtEpochMs,
        clientInstanceId: 'instance-1',
        sessionId: 'session-1',
        actor: {
            kind: 'service',
            serviceId: 'pglite-test'
        },
        reason: null,
        traceId: null,
        requestId: null,
        payload: {},
        ...overrides
    };
}

export function createGroupStateEvent(input: CreateGroupStateEventInput): GroupEvent {
    const {
        eventId,
        occurredAtEpochMs,
        snapshotVersion,
        eventType = 'session-connected',
        overrides = {}
    } = input;
    return {
        applicationId: 'rallar-test',
        workspaceId: 'main',
        groupId: 'room-1',
        eventId,
        eventType,
        snapshotVersion,
        causalRevision: {
            groupRevision: snapshotVersion,
            presenceRevision: 0
        },
        occurredAtEpochMs,
        actor: {
            kind: 'service',
            serviceId: 'pglite-test'
        },
        reason: null,
        traceId: null,
        requestId: null,
        payload: {},
        ...overrides
    };
}

export function canonicalAuditStamp(atEpochMs: number): AuditStamp {
    return {
        atEpochMs,
        actor: { kind: 'service', serviceId: 'pglite-test' },
        reason: null,
        traceId: null,
        requestId: null
    };
}
