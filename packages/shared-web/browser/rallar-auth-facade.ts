import type { RallarOperationOptions } from '@shared-web/browser/rallar-operation-options.ts';
import type {
    RallarOnChangeOptions,
    RallarStateListener,
    RallarUnsubscribe
} from '@shared-web/browser/rallar-shared-contracts.ts';
import type {
    AuthSession,
    LoginRequest,
    LoginResponse,
    RegisterRequest,
    RegisterResponse
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

export type RallarAuthChangeListener = RallarStateListener<RallarAuthState>;

export type RallarRegisterOptions =
    & RallarOperationOptions
    & Readonly<{
        adminSession?: AuthSession | null;
    }>;

export type RallarAuthFacade = Readonly<{
    login(
        request: LoginRequest,
        options?: RallarOperationOptions
    ): Promise<LoginResponse>;
    register(
        request: RegisterRequest,
        options?: RallarRegisterOptions
    ): Promise<RegisterResponse>;
    registerAndLogin(
        request: RegisterRequest,
        options?: RallarRegisterOptions
    ): Promise<LoginResponse>;
    logout(options?: RallarOperationOptions): Promise<void>;
    restore(): AuthSession | undefined;
    isLoggedIn(): boolean;
    onChange(
        listener: RallarAuthChangeListener,
        options?: RallarOnChangeOptions
    ): RallarUnsubscribe;
}>;
