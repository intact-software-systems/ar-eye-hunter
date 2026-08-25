import type { ClientSnapshot } from '@shared/api/client-types.ts';
import { toApiMutationRequestPath } from '@shared/api/mutation/api-mutation-request.ts';
import type { StateScope } from '@shared/api/state-types.ts';

import { readApiBaseUrl } from '../api-client-config.ts';
import { executeHttpRequest, type ApiMutationRequestOptions } from '../api/http-request.ts';
import { defaultStateScope, toStateScopeHttpPath } from '../api/state-http-path.ts';
import type {
    ConnectStateClientSessionBody,
    HeartbeatStateClientSessionBody
} from '../api/state-mutation-http-contracts.ts';

interface ClientSessionRequestInput<TRequest> {
    readonly principalId: string;
    readonly clientInstanceId: string;
    readonly sessionId: string;
    readonly request: TRequest;
    readonly options: ApiMutationRequestOptions;
    readonly scope?: StateScope;
}

export interface ConnectStateClientSessionHttpInput extends ClientSessionRequestInput<ConnectStateClientSessionBody> {}

export interface HeartbeatStateClientSessionHttpInput
    extends ClientSessionRequestInput<HeartbeatStateClientSessionBody> {}

export async function connectStateClientSession(
    input: ConnectStateClientSessionHttpInput
): Promise<ClientSnapshot> {
    return await mutateClientSession(input, 'PUT', '');
}

export async function heartbeatStateClientSession(
    input: HeartbeatStateClientSessionHttpInput
): Promise<ClientSnapshot> {
    return await mutateClientSession(input, 'POST', '/heartbeat');
}

async function mutateClientSession<TRequest>(
    input: ClientSessionRequestInput<TRequest>,
    method: 'POST' | 'PUT',
    suffix: '' | '/heartbeat'
): Promise<ClientSnapshot> {
    const scope = input.scope ?? defaultStateScope();
    const clientPath = `${toStateScopeHttpPath(scope)}/clients/${encodeURIComponent(input.principalId)}`;
    const instancePath = `${clientPath}/instances/${encodeURIComponent(input.clientInstanceId)}`;
    const sessionPath = `${instancePath}/sessions/${encodeURIComponent(input.sessionId)}${suffix}`;
    return await executeHttpRequest<TRequest, ClientSnapshot>(
        readApiBaseUrl(),
        toApiMutationRequestPath(sessionPath, input.options.requestId),
        method,
        input.request,
        input.options
    );
}
