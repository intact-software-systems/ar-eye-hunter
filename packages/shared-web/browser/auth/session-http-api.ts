import type {
    LoginRequest,
    LoginResponse,
    LogoutResponse,
    RegisterRequest,
    RegisterResponse,
} from '@shared/api/api-config.ts';
import { toApiMutationRequestPath } from '@shared/api/mutation/api-mutation.ts';

import { readApiBaseUrl } from '../api-client-config.ts';
import { type ApiRequestOptions, executeHttpRequest } from '../api/http-request.ts';

export async function loginToApi(
    request: LoginRequest,
    options?: ApiRequestOptions,
): Promise<LoginResponse> {
    return await executeHttpRequest<LoginRequest, LoginResponse>(
        readApiBaseUrl(),
        toApiMutationRequestPath('/api/auth/login', crypto.randomUUID()),
        'POST',
        request,
        options,
    );
}

export async function registerWithApi(
    request: RegisterRequest,
    options?: ApiRequestOptions,
): Promise<RegisterResponse> {
    return await executeHttpRequest<RegisterRequest, RegisterResponse>(
        readApiBaseUrl(),
        toApiMutationRequestPath('/api/auth/register', crypto.randomUUID()),
        'POST',
        request,
        options,
    );
}

export async function logoutFromApi(
    options?: ApiRequestOptions,
): Promise<LogoutResponse> {
    return await executeHttpRequest<Record<string, never>, LogoutResponse>(
        readApiBaseUrl(),
        toApiMutationRequestPath('/api/auth/logout', crypto.randomUUID()),
        'POST',
        {},
        options,
    );
}
