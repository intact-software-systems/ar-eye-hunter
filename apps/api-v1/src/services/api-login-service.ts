import {
    authenticateAuthUser,
    type LoginClientData
} from '@shared-server/rallar-system/auth/login/authenticate-auth-user.ts';
import { prepareAuthUserRegistration } from '@shared-server/rallar-system/auth/login/prepare-auth-user-registration.ts';
import { type AuthUserRepository } from '@shared-server/rallar-system/auth/persistence/auth-user-repository.ts';
import type { LoginRequest, RegisterRequest } from '@shared/api/api-config.ts';

export interface RegisterInput {
    readonly request: RegisterRequest;
    readonly staticClients: readonly LoginClientData[];
    readonly capturedAtEpochMs: number;
    readonly clientId: string;
    readonly passwordSaltSeed?: string;
}

export interface LoginInput {
    readonly request: LoginRequest;
    readonly userRepository: AuthUserRepository;
    readonly staticClients: readonly LoginClientData[];
}

export async function register(
    input: RegisterInput
) {
    return await prepareAuthUserRegistration(
        input.request,
        {
            clientId: input.clientId,
            capturedAtEpochMs: input.capturedAtEpochMs,
            passwordSaltSeed: input.passwordSaltSeed
        },
        input.staticClients
    );
}

export async function login(input: LoginInput) {
    return await authenticateAuthUser(input.request, {
        userRepository: input.userRepository,
        staticClients: input.staticClients
    });
}
