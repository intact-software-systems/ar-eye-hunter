import type { AuthSession, LoginRequest, LoginResponse, RegisterRequest } from '@shared/api/api-config.ts';
import type { RallarBlackBoxBootstrapConfig } from './runtime-store.ts';

export type RallarBlackBoxAuthFacade = Readonly<{
    configure(config: { apiBaseUrl?: string }): void;
    auth: Readonly<{
        login(request: LoginRequest): Promise<LoginResponse>;
        registerAndLogin(request: RegisterRequest): Promise<LoginResponse>;
    }>;
}>;

export type RallarBlackBoxLoginInput = Readonly<{
    apiBaseUrl: string;
    username: string;
    password: string;
    register?: boolean;
}>;

export async function authenticateRallarBlackBox(
    facade: RallarBlackBoxAuthFacade,
    input: RallarBlackBoxLoginInput,
): Promise<AuthSession> {
    facade.configure({ apiBaseUrl: input.apiBaseUrl });
    return input.register
        ? await facade.auth.registerAndLogin({
            username: input.username,
            password: input.password,
        })
        : await facade.auth.login({
            username: input.username,
            password: input.password,
        });
}

export function bootstrapPatchFromAuthSession(
    session: AuthSession,
    apiBaseUrl: string,
): Partial<RallarBlackBoxBootstrapConfig> {
    return {
        apiBaseUrl,
        actor: session.username,
        sessionId: session.sessionId,
        rallarUsername: session.username,
        rallarPassword: undefined,
        rallarRegister: false,
        rallarRestoreSession: true,
    };
}

export function authErrorMessage(error: unknown): string {
    const message = error instanceof Error ? error.message : String(error);
    if (
        message.includes('Failed to fetch') ||
        message.includes('NetworkError') ||
        message.includes('Load failed')
    ) {
        return 'Rallar Server is unreachable or blocked by CORS.';
    }
    if (message.includes('401')) {
        return 'Invalid username or password.';
    }
    if (message.includes('403')) {
        return 'Login is forbidden for this user.';
    }
    return message;
}
