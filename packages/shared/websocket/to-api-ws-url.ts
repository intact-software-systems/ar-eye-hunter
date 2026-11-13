import type { StateScope } from '../api/state-types.ts';

/** The upgrade path `/api/config` serves as `endpoints.createWs`; a client that holds no configuration names it. */
export const API_CREATE_WS_PATH = '/api/ws/:id';

export interface ToApiWsUrlInput {
    readonly wsBaseUrl: string;
    /** `ApiConfig.endpoints.createWs` or `API_CREATE_WS_PATH`: its `:id` names the session. */
    readonly createWsPath: string;
    readonly sessionId: string;
    readonly ticket: string;
    /** Absent for a connect that names no state scope. */
    readonly scope: StateScope | undefined;
}

export function toApiWsUrl(input: ToApiWsUrlInput): string {
    const url = new URL(input.createWsPath.replace(':id', encodeURIComponent(input.sessionId)), input.wsBaseUrl);
    url.searchParams.set('ticket', input.ticket);
    if (input.scope !== undefined) {
        url.searchParams.set('applicationId', input.scope.applicationId);
        url.searchParams.set('workspaceId', input.scope.workspaceId);
    }
    return url.toString();
}
