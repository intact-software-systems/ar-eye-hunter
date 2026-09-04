import type { GroupEvent, GroupRef } from '@shared/api/group-types.ts';
import type { StateEventPage } from '@shared/api/state-event-types.ts';

import type { PSqlSql } from '../../../postgres/p-sql-sql.ts';
import { GroupStateEventCollisionError, type GroupStateEventStore } from '../group-state-event-store.ts';
import { DEFAULT_STATE_EVENT_LIST_LIMIT, type StateEventListQuery } from '../state-event-listing.ts';
import { toStateEventCursor } from '../state-event-ordering.ts';
import {
    assertPersistableGroupStateEvent,
    isExactPersistedGroupStateEvent,
    toValidatedGroupStateEvent
} from './group-state-event-row-codec.ts';
import { groupStateEventWorkspaceKey } from './group-state-event-workspace-key.ts';
import {
    insertPSqlGroupStateEvent,
    readAllPSqlGroupStateEventRows,
    readPSqlGroupStateEventCollision,
    readPSqlGroupStateEventPageRows,
    readPSqlGroupStateEventRow,
    readRecentPSqlGroupStateEventRows
} from './p-sql-group-state-event-queries.ts';

export class PSqlGroupStateEventRepository implements GroupStateEventStore {
    private readonly sql: PSqlSql;

    constructor(sql: PSqlSql) {
        this.sql = sql;
    }

    async appendGroupEvent(event: GroupEvent): Promise<void> {
        assertPersistableGroupStateEvent(event, event);
        const eventJson = JSON.stringify(event);
        const workspaceKey = groupStateEventWorkspaceKey(event.workspaceId);
        if (
            await insertPSqlGroupStateEvent({
                sql: this.sql,
                event,
                workspaceKey,
                eventJson
            })
        ) {
            return;
        }
        const existing = await readPSqlGroupStateEventCollision(this.sql, event);
        if (existing === undefined || !isExactPersistedGroupStateEvent(existing, event, eventJson)) {
            throw new GroupStateEventCollisionError(event);
        }
    }

    async listGroupEvents(ref: GroupRef): Promise<readonly GroupEvent[]> {
        const rows = await readAllPSqlGroupStateEventRows(this.sql, ref);
        return rows.map((row) => toValidatedGroupStateEvent(row, ref));
    }

    async readGroupEvent(ref: GroupRef, eventId: string): Promise<GroupEvent | undefined> {
        const row = await readPSqlGroupStateEventRow(this.sql, ref, eventId);
        return row === undefined ? undefined : toValidatedGroupStateEvent(row, ref);
    }

    async listRecentGroupEvents(
        ref: GroupRef,
        query: StateEventListQuery = {}
    ): Promise<readonly GroupEvent[]> {
        const rows = await readRecentPSqlGroupStateEventRows({
            sql: this.sql,
            ref,
            query,
            limit: query.limit ?? DEFAULT_STATE_EVENT_LIST_LIMIT
        });
        return rows.map((row) => toValidatedGroupStateEvent(row, ref));
    }

    async listGroupEventPage(
        ref: GroupRef,
        query: StateEventListQuery = {}
    ): Promise<StateEventPage<GroupEvent>> {
        const limit = query.limit ?? DEFAULT_STATE_EVENT_LIST_LIMIT;
        const rows = await readPSqlGroupStateEventPageRows({
            sql: this.sql,
            ref,
            query,
            limit: limit + 1
        });
        const eventsPlusOne = rows.map((row) => toValidatedGroupStateEvent(row, ref));
        const events = eventsPlusOne.slice(0, limit);
        const lastEvent = events.at(-1);
        return {
            events,
            ...(lastEvent === undefined ? {} : { nextCursor: toStateEventCursor(lastEvent) }),
            hasMore: eventsPlusOne.length > limit
        };
    }
}
