import {
    authenticateAuthUser,
    type LoginClientData
} from '@shared-server/rallar-system/auth/login/authenticate-auth-user.ts';
import { prepareAuthUserRegistration } from '@shared-server/rallar-system/auth/login/prepare-auth-user-registration.ts';
import { type AuthUserRepository } from '@shared-server/rallar-system/auth/persistence/auth-user-repository.ts';
import type { LoginRequest, RegisterRequest } from '@shared/api/api-config.ts';
import authorisedClientsJson from '../../resources/authorised-clients.json' with { type: 'json' };

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

export type AuthStaticClientsMode = 'demo' | 'disabled';

const authorisedClients = authorisedClientsJson as readonly LoginClientData[];

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

export function readAuthStaticClientsMode(env: Pick<Deno.Env, 'get'>): AuthStaticClientsMode {
    const raw = env.get('AUTH_STATIC_CLIENTS_MODE')?.trim().toLowerCase();
    if (!raw || raw === 'demo') {
        return 'demo';
    }
    if (raw === 'disabled') {
        return 'disabled';
    }

    throw new Error('AUTH_STATIC_CLIENTS_MODE must be demo or disabled.');
}

export function readAuthorisedClients(
    env: Pick<Deno.Env, 'get'>
): readonly LoginClientData[] {
    return readAuthStaticClientsMode(env) === 'disabled' ? [] : authorisedClients;
}
