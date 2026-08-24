import * as authApi from '@shared-web/browser/auth/session-http-api.ts';
import type { RallarAuthFacade, RallarRegisterOptions } from '@shared-web/browser/rallar-auth-facade.ts';
import { toRallarCommandOptions, type RallarOperationOptions } from '@shared-web/browser/rallar-operation-options.ts';
import type { RallarConnectionRuntimePort } from '@shared-web/browser/rallar-runtime-context.ts';
import type { LoginRequest, LoginResponse, RegisterRequest, RegisterResponse } from '@shared/api/api-config.ts';
import { isLoggedIn } from '@shared/api/auth.ts';
import { Command } from '@shared/cache/Command.ts';

import type { RallarSessionAuthLifecycle } from './session-auth-lifecycle.ts';

export interface CreateRallarSessionAuthOperationsInput {
    readonly connectionRuntime: RallarConnectionRuntimePort;
    readonly authLifecycle: RallarSessionAuthLifecycle;
}

export function createRallarSessionAuthOperations(
    input: CreateRallarSessionAuthOperationsInput
): RallarAuthFacade {
    const login = async (
        request: LoginRequest,
        options: RallarOperationOptions = {}
    ): Promise<LoginResponse> => {
        const operationOptions = input.connectionRuntime.resolveOperationOptions(options);
        const requestId = crypto.randomUUID();
        const response = await runRallarCommand(
            (signal) => authApi.loginToApi(request, { requestId, signal }),
            operationOptions
        );
        await input.authLifecycle.activateLoginSession(response);
        return response;
    };

    const register = async (
        request: RegisterRequest,
        options: RallarRegisterOptions = {}
    ): Promise<RegisterResponse> => {
        const operationOptions = input.connectionRuntime.resolveOperationOptions(options);
        const requestId = crypto.randomUUID();
        return await runRallarCommand(
            (signal) =>
                authApi.registerWithApi(request, {
                    requestId,
                    signal,
                    authSession: operationOptions.adminSession
                }),
            operationOptions
        );
    };

    return {
        login,
        register,
        registerAndLogin: async (request, options = {}) => {
            await register(request, options);
            return await login(
                { username: request.username, password: request.password },
                options
            );
        },
        logout: async (options = {}) => {
            await input.authLifecycle.endAuthSession('logout', {
                revoke: true,
                operationOptions: input.connectionRuntime.resolveOperationOptions(options)
            });
        },
        restore: () => input.authLifecycle.restoreSession(),
        isLoggedIn: () => isLoggedIn(),
        onChange: (listener, options = {}) => input.authLifecycle.onAuthChange(listener, options)
    };
}

function runRallarCommand<T>(
    supplier: (signal?: AbortSignal) => T | Promise<T>,
    options: RallarOperationOptions
): Promise<T> {
    return new Command<T>(supplier, toRallarCommandOptions(options)).run();
}
