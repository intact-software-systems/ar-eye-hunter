import type { ClientEvent, ClientPrincipalRef } from '@shared/api/client-types.ts';
import type { StateEventPage } from '@shared/api/state-event-types.ts';

import type { PSqlSql } from '../../../postgres/p-sql-sql.ts';
import { ClientStateEventCollisionError, type ClientStateEventStore } from '../client-state-event-store.ts';
import { DEFAULT_STATE_EVENT_LIST_LIMIT, type StateEventListQuery } from '../state-event-listing.ts';
import { toStateEventCursor } from '../state-event-ordering.ts';
import {
    assertPersistableClientStateEvent,
    isExactPersistedClientStateEvent,
    toValidatedClientStateEvent
} from './client-state-event-row-codec.ts';
import {
    insertPSqlClientStateEvent,
    readAllPSqlClientStateEventRows,
    readPSqlClientStateEventCollision,
    readPSqlClientStateEventPageRows,
    readRecentPSqlClientStateEventRows
} from './p-sql-client-state-event-queries.ts';

export class PSqlClientStateEventRepository implements ClientStateEventStore {
    private readonly sql: PSqlSql;

    constructor(sql: PSqlSql) {
        this.sql = sql;
    }

    async appendClientEvent(event: ClientEvent): Promise<void> {
        assertPersistableClientStateEvent(event, event);
        const eventJson = JSON.stringify(event);
        if (await insertPSqlClientStateEvent(this.sql, event, eventJson)) {
            return;
        }
        const existing = await readPSqlClientStateEventCollision(this.sql, event);
        if (existing === undefined || !isExactPersistedClientStateEvent(existing, event, eventJson)) {
            throw new ClientStateEventCollisionError(event);
        }
    }

    async listClientEvents(ref: ClientPrincipalRef): Promise<readonly ClientEvent[]> {
        const rows = await readAllPSqlClientStateEventRows(this.sql, ref);
        return rows.map((row) => toValidatedClientStateEvent(row, ref));
    }

    async listRecentClientEvents(
        ref: ClientPrincipalRef,
        query: StateEventListQuery = {}
    ): Promise<readonly ClientEvent[]> {
        const rows = await readRecentPSqlClientStateEventRows({
            sql: this.sql,
            ref,
            query,
            limit: query.limit ?? DEFAULT_STATE_EVENT_LIST_LIMIT
        });
        return rows.map((row) => toValidatedClientStateEvent(row, ref));
    }

    async listClientEventPage(
        ref: ClientPrincipalRef,
        query: StateEventListQuery = {}
    ): Promise<StateEventPage<ClientEvent>> {
        const limit = query.limit ?? DEFAULT_STATE_EVENT_LIST_LIMIT;
        const rows = await readPSqlClientStateEventPageRows({
            sql: this.sql,
            ref,
            query,
            limit: limit + 1
        });
        const eventsPlusOne = rows.map((row) => toValidatedClientStateEvent(row, ref));
        const events = eventsPlusOne.slice(0, limit);
        const lastEvent = events.at(-1);
        return {
            events,
            ...(lastEvent === undefined ? {} : { nextCursor: toStateEventCursor(lastEvent) }),
            hasMore: eventsPlusOne.length > limit
        };
    }
}
