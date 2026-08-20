import type {
    LoginRequest,
    LoginResponse,
    LogoutResponse,
    RegisterRequest,
    RegisterResponse,
} from '@shared/api/api-config.ts';
import { toApiMutationRequestPath } from '@shared/api/mutation/api-mutation-request.ts';

import { readApiBaseUrl } from '../api-client-config.ts';
import {
    type ApiMutationRequestOptions,
    executeHttpRequest,
} from '../api/http-request.ts';

export async function loginToApi(
    request: LoginRequest,
    options: ApiMutationRequestOptions,
): Promise<LoginResponse> {
    return await executeHttpRequest<LoginRequest, LoginResponse>(
        readApiBaseUrl(),
        toApiMutationRequestPath('/api/auth/login', options.requestId),
        'POST',
        request,
        options,
    );
}

export async function registerWithApi(
    request: RegisterRequest,
    options: ApiMutationRequestOptions,
): Promise<RegisterResponse> {
    return await executeHttpRequest<RegisterRequest, RegisterResponse>(
        readApiBaseUrl(),
        toApiMutationRequestPath('/api/auth/register', options.requestId),
        'POST',
        request,
        options,
    );
}

export async function logoutFromApi(
    options: ApiMutationRequestOptions,
): Promise<LogoutResponse> {
    return await executeHttpRequest<Record<string, never>, LogoutResponse>(
        readApiBaseUrl(),
        toApiMutationRequestPath('/api/auth/logout', options.requestId),
        'POST',
        {},
        options,
    );
}
