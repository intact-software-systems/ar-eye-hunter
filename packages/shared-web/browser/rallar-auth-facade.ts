import type { RallarOperationOptions } from '@shared-web/browser/rallar-operation-options.ts';
import type {
    RallarOnChangeOptions,
    RallarStateListener,
    RallarUnsubscribe,
} from '@shared-web/browser/rallar-shared-contracts.ts';
import type {
    AuthSession,
    LoginRequest,
    LoginResponse,
    RegisterRequest,
    RegisterResponse,
} from '@shared/api/api-config.ts';

export type RallarAuthChangeReason =
    | 'current'
    | 'login'
    | 'logout'
    | 'expired'
    | 'unauthorized';

export type RallarAuthState = Readonly<{
    authenticated: boolean;
    reason: RallarAuthChangeReason;
    session?: AuthSession;
}>;

export type RallarAuthChangeListener =
    RallarStateListener<RallarAuthState>;

export type RallarRegisterOptions =
    & RallarOperationOptions
    & Readonly<{
    adminSession?: AuthSession | null;
}>;

export type RallarAuthFacade = Readonly<{
    login(
        request: LoginRequest,
        options?: RallarOperationOptions,
    ): Promise<LoginResponse>;
    register(
        request: RegisterRequest,
        options?: RallarRegisterOptions,
    ): Promise<RegisterResponse>;
    registerAndLogin(
        request: RegisterRequest,
        options?: RallarRegisterOptions,
    ): Promise<LoginResponse>;
    logout(options?: RallarOperationOptions): Promise<void>;
    restore(): AuthSession | undefined;
    isLoggedIn(): boolean;
    onChange(
        listener: RallarAuthChangeListener,
        options?: RallarOnChangeOptions,
    ): RallarUnsubscribe;
}>;

export type CreateRallarAuthFacadeOptions = RallarAuthFacade;

export function createRallarAuthFacade(
    operations: CreateRallarAuthFacadeOptions,
): RallarAuthFacade {
    return {
        login: async (
            request,
            options = {},
        ): Promise<LoginResponse> => await operations.login(request, options),
        register: async (
            request,
            options = {},
        ): Promise<RegisterResponse> => await operations.register(request, options),
        registerAndLogin: async (
            request,
            options = {},
        ): Promise<LoginResponse> =>
            await operations.registerAndLogin(request, options),
        logout: async (options = {}): Promise<void> =>
            await operations.logout(options),
        restore: (): AuthSession | undefined => operations.restore(),
        isLoggedIn: (): boolean => operations.isLoggedIn(),
        onChange: (
            listener,
            options = {},
        ): RallarUnsubscribe => operations.onChange(listener, options),
    };
}
