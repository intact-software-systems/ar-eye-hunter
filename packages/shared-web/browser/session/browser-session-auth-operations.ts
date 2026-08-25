import * as authApi from '@shared-web/browser/auth/session-http-api.ts';
import { toRallarCommandOptions, type RallarOperationOptions } from '@shared-web/browser/rallar-operation-options.ts';
import type { RallarConnectionRuntimePort } from '@shared-web/browser/rallar-runtime-context.ts';
import type {
    RallarAuthChangeListener,
    RallarAuthFacade,
    RallarRegisterOptions
} from '@shared-web/browser/session/rallar-auth-facade.ts';
import type {
    RallarOnChangeOptions,
    RallarUnsubscribe
} from '@shared-web/browser/rallar-shared-contracts.ts';
import type {
    AuthSession,
    LoginRequest,
    LoginResponse,
    RegisterRequest,
    RegisterResponse
} from '@shared/api/api-config.ts';
import { isLoggedIn } from '@shared/api/auth.ts';
import { Command } from '@shared/cache/Command.ts';

import type { RallarSessionAuthLifecycle } from './session-auth-lifecycle.ts';

export namespace BrowserSessionAuthOperations {
    export interface Input {
        readonly connectionRuntime: RallarConnectionRuntimePort;
        readonly authLifecycle: RallarSessionAuthLifecycle;
    }
}

/** Owns public auth commands while the lifecycle owns session state transitions. */
export class BrowserSessionAuthOperations implements RallarAuthFacade {
    private readonly input: BrowserSessionAuthOperations.Input;

    public constructor(input: BrowserSessionAuthOperations.Input) {
        this.input = input;
    }

    public async login(
        request: LoginRequest,
        options: RallarOperationOptions = {}
    ): Promise<LoginResponse> {
        const operationOptions = this.input.connectionRuntime.resolveOperationOptions(options);
        const requestId = crypto.randomUUID();
        const response = await runRallarCommand(
            (signal) => authApi.loginToApi(request, { requestId, signal }),
            operationOptions
        );
        await this.input.authLifecycle.activateLoginSession(response);
        return response;
    }

    public async register(
        request: RegisterRequest,
        options: RallarRegisterOptions = {}
    ): Promise<RegisterResponse> {
        const operationOptions = this.input.connectionRuntime.resolveOperationOptions(options);
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
    }

    public async registerAndLogin(
        request: RegisterRequest,
        options: RallarRegisterOptions = {}
    ): Promise<LoginResponse> {
        await this.register(request, options);
        return await this.login(
            { username: request.username, password: request.password },
            options
        );
    }

    public async logout(options: RallarOperationOptions = {}): Promise<void> {
        await this.input.authLifecycle.endAuthSession('logout', {
            revoke: true,
            operationOptions: this.input.connectionRuntime.resolveOperationOptions(options)
        });
    }

    public restore(): AuthSession | undefined {
        return this.input.authLifecycle.restoreSession();
    }

    public isLoggedIn(): boolean {
        return isLoggedIn();
    }

    public onChange(
        listener: RallarAuthChangeListener,
        options: RallarOnChangeOptions = {}
    ): RallarUnsubscribe {
        return this.input.authLifecycle.onAuthChange(listener, options);
    }
}

function runRallarCommand<T>(
    supplier: (signal?: AbortSignal) => T | Promise<T>,
    options: RallarOperationOptions
): Promise<T> {
    return new Command<T>(supplier, toRallarCommandOptions(options)).run();
}
