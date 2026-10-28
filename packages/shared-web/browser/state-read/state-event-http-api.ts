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
import { sendApiHttpRequest, type ApiRequestOptions } from '../api/send-api-http-request.ts';
import { defaultStateScope, toStateScopeHttpPath } from '../api/state-http-path.ts';

export interface StateEventListRequestOptions<TEventType extends string> extends ApiRequestOptions {
    readonly eventTypes?: readonly TEventType[];
    readonly limit?: number;
    readonly after?: StateEventCursor;
}

export type GroupStateEventListRequestOptions = StateEventListRequestOptions<GroupEventType>;
export type ClientStateEventListRequestOptions = StateEventListRequestOptions<ClientEventType>;

export async function listStateGroupEvents(
    groupId: string,
    scope: StateScope = defaultStateScope(),
    options?: GroupStateEventListRequestOptions
): Promise<GroupEvent[]> {
    const response = await sendApiHttpRequest<void, GroupEvent[]>({
        baseUrl: readApiBaseUrl(),
        path: toStateEventPath({ scope, collection: 'groups', id: groupId, suffix: 'events', options }),
        method: 'GET',
        body: undefined,
        options
    });
    validateAuthoritativeGroupEventList(response, { ...scope, groupId });
    return response;
}

export async function listStateGroupEventPage(
    groupId: string,
    scope: StateScope = defaultStateScope(),
    options?: GroupStateEventListRequestOptions
): Promise<StateEventPage<GroupEvent>> {
    const response = await sendApiHttpRequest<void, StateEventPage<GroupEvent>>({
        baseUrl: readApiBaseUrl(),
        path: toStateEventPath({ scope, collection: 'groups', id: groupId, suffix: 'events/page', options }),
        method: 'GET',
        body: undefined,
        options
    });
    validateAuthoritativeGroupEventPage(response, { ...scope, groupId });
    return response;
}

export async function listStateClientEvents(
    principalId: string,
    scope: StateScope = defaultStateScope(),
    options?: ClientStateEventListRequestOptions
): Promise<ClientEvent[]> {
    const response = await sendApiHttpRequest<void, ClientEvent[]>({
        baseUrl: readApiBaseUrl(),
        path: toStateEventPath({ scope, collection: 'clients', id: principalId, suffix: 'events', options }),
        method: 'GET',
        body: undefined,
        options
    });
    validateAuthoritativeClientEventList(response, { ...scope, principalId });
    return response;
}

export async function listStateClientEventPage(
    principalId: string,
    scope: StateScope = defaultStateScope(),
    options?: ClientStateEventListRequestOptions
): Promise<StateEventPage<ClientEvent>> {
    const response = await sendApiHttpRequest<void, StateEventPage<ClientEvent>>({
        baseUrl: readApiBaseUrl(),
        path: toStateEventPath({ scope, collection: 'clients', id: principalId, suffix: 'events/page', options }),
        method: 'GET',
        body: undefined,
        options
    });
    validateAuthoritativeClientEventPage(response, { ...scope, principalId });
    return response;
}

interface StateEventPathInput<TEventType extends string> {
    readonly scope: StateScope;
    readonly collection: 'clients' | 'groups';
    readonly id: string;
    readonly suffix: 'events' | 'events/page';
    readonly options: StateEventListRequestOptions<TEventType> | undefined;
}

function toStateEventPath<TEventType extends string>(
    { scope, collection, id, suffix, options }: StateEventPathInput<TEventType>
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
