import {
    validateAuthoritativeClientEventList,
    validateAuthoritativeClientEventPage,
    validateAuthoritativeGroupEventList,
    validateAuthoritativeGroupEventPage
} from '@shared/api/authoritative-state-validation.ts';
import type { ClientEvent, ClientEventType } from '@shared/api/client-types.ts';
import type { GroupEvent, GroupEventType } from '@shared/api/group-types.ts';
import type { StateEventCursor, StateEventPage } from '@shared/api/state-event-types.ts';
import type { StateScope } from '@shared/api/state-types.ts';

import { readApiBaseUrl } from '../api-client-config.ts';
import { executeHttpRequest, type ApiRequestOptions } from '../api/http-request.ts';
import { defaultStateScope, toStateScopeHttpPath } from '../api/state-http-path.ts';

export type StateEventListRequestOptions<TEventType extends string> =
    & ApiRequestOptions
    & Readonly<{
        eventTypes?: readonly TEventType[];
        limit?: number;
        after?: StateEventCursor;
    }>;

export type GroupStateEventListRequestOptions = StateEventListRequestOptions<GroupEventType>;
export type ClientStateEventListRequestOptions = StateEventListRequestOptions<ClientEventType>;

export async function listStateGroupEvents(
    groupId: string,
    scope: StateScope = defaultStateScope(),
    options?: GroupStateEventListRequestOptions
): Promise<GroupEvent[]> {
    const response = await executeHttpRequest<void, GroupEvent[]>(
        readApiBaseUrl(),
        stateEventPath(scope, 'groups', groupId, 'events', options),
        'GET',
        undefined,
        options
    );
    validateAuthoritativeGroupEventList(response, { ...scope, groupId });
    return response;
}

export async function listStateGroupEventPage(
    groupId: string,
    scope: StateScope = defaultStateScope(),
    options?: GroupStateEventListRequestOptions
): Promise<StateEventPage<GroupEvent>> {
    const response = await executeHttpRequest<void, StateEventPage<GroupEvent>>(
        readApiBaseUrl(),
        stateEventPath(scope, 'groups', groupId, 'events/page', options),
        'GET',
        undefined,
        options
    );
    validateAuthoritativeGroupEventPage(response, { ...scope, groupId });
    return response;
}

export async function listStateClientEvents(
    principalId: string,
    scope: StateScope = defaultStateScope(),
    options?: ClientStateEventListRequestOptions
): Promise<ClientEvent[]> {
    const response = await executeHttpRequest<void, ClientEvent[]>(
        readApiBaseUrl(),
        stateEventPath(scope, 'clients', principalId, 'events', options),
        'GET',
        undefined,
        options
    );
    validateAuthoritativeClientEventList(response, { ...scope, principalId });
    return response;
}

export async function listStateClientEventPage(
    principalId: string,
    scope: StateScope = defaultStateScope(),
    options?: ClientStateEventListRequestOptions
): Promise<StateEventPage<ClientEvent>> {
    const response = await executeHttpRequest<void, StateEventPage<ClientEvent>>(
        readApiBaseUrl(),
        stateEventPath(scope, 'clients', principalId, 'events/page', options),
        'GET',
        undefined,
        options
    );
    validateAuthoritativeClientEventPage(response, { ...scope, principalId });
    return response;
}

function stateEventPath<TEventType extends string>(
    scope: StateScope,
    collection: 'clients' | 'groups',
    id: string,
    suffix: 'events' | 'events/page',
    options?: StateEventListRequestOptions<TEventType>
): string {
    const path = `${toStateScopeHttpPath(scope)}/${collection}/${encodeURIComponent(id)}/${suffix}`;
    const query = new URLSearchParams();
    for (const eventType of options?.eventTypes ?? []) {
        query.append('eventType', eventType);
    }
    if (options?.limit !== undefined) {
        query.set('limit', String(options.limit));
    }
    if (options?.after) {
        query.set('afterSnapshotVersion', String(options.after.snapshotVersion));
        query.set('afterOccurredAtEpochMs', String(options.after.occurredAtEpochMs));
        query.set('afterEventId', options.after.eventId);
    }
    return query.size === 0 ? path : `${path}?${query}`;
}
