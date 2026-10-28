import type {
    LoginRequest,
    LoginResponse,
    LogoutResponse,
    RegisterRequest,
    RegisterResponse
} from '@shared/api/api-config.ts';
import { toApiMutationRequestPath } from '@shared/api/mutation/api-mutation-request.ts';

import { readApiBaseUrl } from '../api-client-config.ts';
import { sendApiHttpRequest, type ApiMutationRequestOptions } from '../api/send-api-http-request.ts';

export async function loginToApi(
    request: LoginRequest,
    options: ApiMutationRequestOptions
): Promise<LoginResponse> {
    return await sendApiHttpRequest<LoginRequest, LoginResponse>({
        baseUrl: readApiBaseUrl(),
        path: toApiMutationRequestPath('/api/auth/login', options.requestId),
        method: 'POST',
        body: request,
        options
    });
}

export async function registerWithApi(
    request: RegisterRequest,
    options: ApiMutationRequestOptions
): Promise<RegisterResponse> {
    return await sendApiHttpRequest<RegisterRequest, RegisterResponse>({
        baseUrl: readApiBaseUrl(),
        path: toApiMutationRequestPath('/api/auth/register', options.requestId),
        method: 'POST',
        body: request,
        options
    });
}

export async function logoutFromApi(
    options: ApiMutationRequestOptions
): Promise<LogoutResponse> {
    return await sendApiHttpRequest<Record<string, never>, LogoutResponse>({
        baseUrl: readApiBaseUrl(),
        path: toApiMutationRequestPath('/api/auth/logout', options.requestId),
        method: 'POST',
        body: {},
        options
    });
}
