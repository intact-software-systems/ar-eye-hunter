import { GroupStateRepository } from '@shared-server/rallar-system/group-state/persistence/group-state-repository.ts';
import { computeGroupStateEventWrite, validateGroupStateEventWrite } from '@shared-server/rallar-system/state-events/group-state-event-store.ts';
import { PSqlGroupStateEventRepository } from '@shared-server/rallar-system/state-events/postgres/p-sql-group-state-event-repository.ts';
import { PSqlRuntimeStateRepository } from '@shared-server/runtime-state/postgres/p-sql-runtime-state-repository.ts';
import type { AuditStamp, Group, GroupEvent, GroupRef } from '@shared/api/group-types.ts';
import { expect, it } from 'vitest';

import { createTestGroup } from '../../../create-test-group.ts';
import { createRuntimeStatePostgresSql, requirePostgresDatabaseUrl } from '../../runtime-state/postgres/postgres-runtime-state-client-fixtures.ts';
import { cleanupRuntimeState } from './presence/presence-expiry-concurrency-test-runtime.ts';

const postgresIt = process.env.RALLAR_POSTGRES_INTEGRATION === '1' ? it : it.skip;

postgresIt('isolates default and explicit sentinel workspaces at the live group and event boundaries', async () => {
    const sql = await createRuntimeStatePostgresSql(requirePostgresDatabaseUrl());
    const applicationId = `group-scope-key-isolation-${crypto.randomUUID()}`;
    const groups = ['workspace-default', '_'].map((workspaceId) =>
        groupFixture({
            applicationId,
            workspaceId,
            groupId: 'shared-group'
        })
    );
    const events = groups.map((group, index) => eventFixture(group, index + 1));
    const eventWrites = events.map(computeGroupStateEventWrite);
    const eventStore = new PSqlGroupStateEventRepository(sql);
    const repository = new GroupStateRepository(new PSqlRuntimeStateRepository(sql), eventStore);
    try {
        for (const [index, group] of groups.entries()) {
            expect(validateGroupStateEventWrite(events[index], eventWrites[index])).toEqual([]);
            await repository.putGroup(group);
        }
        await sql.begin(async (transaction) => {
            const writer = new PSqlGroupStateEventRepository(transaction);
            for (const computed of eventWrites) {
                await writer.appendGroupEvent(computed);
                await writer.appendGroupEvent(computed);
            }
        });
        for (const [index, group] of groups.entries()) {
            expect(await repository.findGroup(group)).toEqual(group);
            expect(await repository.listGroups({ applicationId, workspaceId: group.workspaceId })).toEqual([group]);
            expect(await eventStore.readGroupEvent(group, 'shared-event')).toEqual(events[index]);
            expect(await eventStore.listGroupEvents(group)).toEqual([events[index]]);
            expect(await eventStore.listRecentGroupEvents(group, {})).toEqual([events[index]]);
            expect((await eventStore.listGroupEventPage(group, { limit: 10 })).events).toEqual([events[index]]);
        }
    }
    finally {
        try {
            await cleanupRuntimeState(sql, applicationId);
        }
        finally {
            await sql.end();
        }
    }
}, 60_000);

function groupFixture(ref: GroupRef): Group {
    const audit: AuditStamp = {
        atEpochMs: 1_000,
        actor: { kind: 'service', serviceId: 'postgres-group-key-test' },
        reason: null,
        traceId: null,
        requestId: null
    };
    return createTestGroup({
        ...ref,
        displayName: ref.workspaceId,
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

function eventFixture(ref: GroupRef, snapshotVersion: number): GroupEvent {
    return {
        applicationId: ref.applicationId,
        workspaceId: ref.workspaceId,
        groupId: ref.groupId,
        eventId: 'shared-event',
        eventType: 'group-updated',
        snapshotVersion,
        causalRevision: { groupRevision: snapshotVersion, presenceRevision: 0 },
        occurredAtEpochMs: 1_000 + snapshotVersion,
        actor: { kind: 'service', serviceId: 'postgres-group-event-key-test' },
        reason: ref.workspaceId,
        traceId: null,
        requestId: null,
        payload: {}
    };
}
