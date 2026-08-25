import type { RegisterRequest } from '@shared/api/api-config.ts';

import { normalizeAuthUsername } from '../credentials/normalize-auth-username.ts';
import type { PersistedAuthUser } from '../persistence/persisted-auth-user.ts';
import type { LoginClientData } from './authenticate-auth-user.ts';

const PASSWORD_ALGORITHM = 'pbkdf2-sha256' as const;
const PASSWORD_ITERATIONS = 120_000;
const PASSWORD_HASH_BITS = 256;
const PASSWORD_SALT_BYTES = 16;
const USERNAME_PATTERN = /^[a-zA-Z0-9._-]+$/;

export interface PreparedAuthUserRegistration {
    readonly username: string;
    readonly normalizedUsername: string;
    readonly displayName: string | null;
    readonly passwordHash: string;
    readonly passwordSalt: string;
    readonly passwordAlgorithm: 'pbkdf2-sha256';
    readonly passwordIterations: number;
    readonly roles: readonly string[];
    readonly status: 'active';
}

export async function prepareAuthUserRegistration(
    request: RegisterRequest,
    facts: Readonly<{
        clientId: string;
        capturedAtEpochMs: number;
        passwordSaltSeed?: string;
    }>,
    staticClients: readonly LoginClientData[] = []
): Promise<PersistedAuthUser> {
    const prepared = await prepareAuthUserRegistrationVerifier(
        request,
        { passwordSaltSeed: facts.passwordSaltSeed },
        staticClients
    );
    return materializeAuthUserRegistration(prepared, facts);
}

export async function prepareAuthUserRegistrationVerifier(
    request: RegisterRequest,
    facts: Readonly<{ passwordSaltSeed?: string; }>,
    staticClients: readonly LoginClientData[] = []
): Promise<PreparedAuthUserRegistration> {
    const username = validateUsername(request.username);
    const normalizedUsername = normalizeAuthUsername(username);
    validatePassword(request.password);
    if (staticClients.some((client) => normalizeAuthUsername(client.username) === normalizedUsername)) {
        throw Object.assign(new Error(`Auth user already exists: ${username}`), {
            code: 'auth-user-exists',
            status: 409
        });
    }
    const password = await hashPassword(request.password, facts.passwordSaltSeed);
    return {
        username,
        normalizedUsername,
        displayName: validateDisplayName(request.displayName) ?? null,
        passwordHash: password.hash,
        passwordSalt: password.salt,
        passwordAlgorithm: PASSWORD_ALGORITHM,
        passwordIterations: PASSWORD_ITERATIONS,
        roles: ['member'],
        status: 'active'
    };
}

export function materializeAuthUserRegistration(
    prepared: PreparedAuthUserRegistration,
    facts: Readonly<{ clientId: string; capturedAtEpochMs: number; }>
): PersistedAuthUser {
    return {
        clientId: facts.clientId,
        ...prepared,
        createdAtEpochMs: facts.capturedAtEpochMs,
        updatedAtEpochMs: facts.capturedAtEpochMs
    };
}

function validateUsername(username: string): string {
    const trimmed = username?.trim();
    if (!trimmed) {
        throw new TypeError('Username is required');
    }
    if (trimmed.length > 64) {
        throw new TypeError('Username must be 64 characters or fewer');
    }
    if (!USERNAME_PATTERN.test(trimmed)) {
        throw new TypeError(
            'Username may only contain letters, numbers, dots, underscores, and dashes'
        );
    }
    return trimmed;
}

function validatePassword(password: string): void {
    if (!password || password.length === 0) {
        throw new TypeError('Password is required');
    }
    if (password.length > 1024) {
        throw new TypeError('Password must be 1024 characters or fewer');
    }
}

function validateDisplayName(displayName: string | undefined): string | undefined {
    const trimmed = displayName?.trim();
    if (!trimmed) {
        return undefined;
    }
    if (trimmed.length > 128) {
        throw new TypeError('Display name must be 128 characters or fewer');
    }
    return trimmed;
}

async function hashPassword(
    password: string,
    saltSeed?: string
): Promise<{ hash: string; salt: string; }> {
    const salt = saltSeed === undefined
        ? crypto.getRandomValues(new Uint8Array(PASSWORD_SALT_BYTES))
        : new Uint8Array(
            (await crypto.subtle.digest('SHA-256', new TextEncoder().encode(saltSeed)))
                .slice(0, PASSWORD_SALT_BYTES)
        );
    const hash = await derivePasswordHash(password, salt, PASSWORD_ITERATIONS);
    return {
        hash: toBase64(hash),
        salt: toBase64(salt)
    };
}

async function derivePasswordHash(
    password: string,
    salt: Uint8Array,
    iterations: number
): Promise<Uint8Array> {
    const keyMaterial = await crypto.subtle.importKey(
        'raw',
        new TextEncoder().encode(password),
        'PBKDF2',
        false,
        ['deriveBits']
    );
    const bits = await crypto.subtle.deriveBits(
        {
            name: 'PBKDF2',
            hash: 'SHA-256',
            salt: toArrayBuffer(salt),
            iterations
        },
        keyMaterial,
        PASSWORD_HASH_BITS
    );
    return new Uint8Array(bits);
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
    const copy = new Uint8Array(bytes.length);
    copy.set(bytes);
    return copy.buffer;
}

function toBase64(bytes: Uint8Array): string {
    let binary = '';
    for (const byte of bytes) {
        binary += String.fromCharCode(byte);
    }
    return btoa(binary);
}
