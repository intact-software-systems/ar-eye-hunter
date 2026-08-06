import type { LoginRequest, RegisterRequest } from '@shared/api/api-config.ts';
import {
    type AuthUser,
    AuthUserRepository,
    normalizeUsername,
} from '../repositories/AuthUserRepository.ts';
import type { IssueAuthSessionCommand } from '../auth/mutation/auth-mutation-contracts.ts';

export type AuthenticatedUserIdentity = Readonly<{
    clientId: string;
    username: string;
    authority: IssueAuthSessionCommand['authority'];
}>;

export type LoginClientData = Readonly<{
    clientId: string;
    username: string;
    password: string;
}>;

export type LoginAuthUserOptions = Readonly<{
    userRepository: AuthUserRepository;
    staticClients?: readonly LoginClientData[];
}>;

const PASSWORD_ALGORITHM = 'pbkdf2-sha256' as const;
const PASSWORD_ITERATIONS = 120_000;
const PASSWORD_HASH_BITS = 256;
const PASSWORD_SALT_BYTES = 16;
const USERNAME_PATTERN = /^[a-zA-Z0-9._-]+$/;

export async function authenticateAuthUser(
    loginRequest: LoginRequest,
    options: LoginAuthUserOptions,
): Promise<AuthenticatedUserIdentity | undefined> {
    const normalizedUsername = normalizeUsername(loginRequest.username);
    const registeredUser = await options.userRepository.findByNormalizedUsernameEntry(
        normalizedUsername,
    );
    if (registeredUser) {
        if (
            registeredUser.value.status !== 'active' ||
            !(await verifyPassword(loginRequest.password, registeredUser.value))
        ) return undefined;
        return {
            clientId: registeredUser.value.clientId,
            username: registeredUser.value.username,
            authority: {
                kind: 'registered-user',
                clientId: registeredUser.value.clientId,
                normalizedUsername: registeredUser.value.normalizedUsername,
                userRevision: registeredUser.entry.revision,
            },
        };
    }
    return authenticateStaticClient(loginRequest, options.staticClients ?? []);
}

export async function prepareAuthUserRegistration(
    request: RegisterRequest,
    facts: Readonly<{
        clientId: string;
        capturedAtEpochMs: number;
    }>,
    staticClients: readonly LoginClientData[] = [],
): Promise<AuthUser> {
    const username = validateUsername(request.username);
    const normalizedUsername = normalizeUsername(username);
    validatePassword(request.password);
    if (staticClients.some((client) =>
        normalizeUsername(client.username) === normalizedUsername
    )) throw new Error(`Auth user already exists: ${username}`);
    const password = await hashPassword(request.password);
    return {
        clientId: facts.clientId,
        username,
        normalizedUsername,
        displayName: validateDisplayName(request.displayName) ?? null,
        passwordHash: password.hash,
        passwordSalt: password.salt,
        passwordAlgorithm: PASSWORD_ALGORITHM,
        passwordIterations: PASSWORD_ITERATIONS,
        roles: ['member'],
        status: 'active',
        createdAtEpochMs: facts.capturedAtEpochMs,
        updatedAtEpochMs: facts.capturedAtEpochMs,
    };
}

function authenticateStaticClient(
    loginRequest: LoginRequest,
    staticClients: readonly LoginClientData[],
): AuthenticatedUserIdentity | undefined {
    const normalizedUsername = normalizeUsername(loginRequest.username);
    for (const client of staticClients) {
        if (
            normalizeUsername(client.username) === normalizedUsername &&
            client.password === loginRequest.password
        ) {
            return {
                clientId: client.clientId,
                username: client.username,
                authority: {
                    kind: 'static-client',
                    clientId: client.clientId,
                    normalizedUsername,
                },
            };
        }
    }

    return undefined;
}

function validateUsername(username: string): string {
    const trimmed = username?.trim();
    if (!trimmed) {
        throw new Error('Username is required');
    }

    if (trimmed.length > 64) {
        throw new Error('Username must be 64 characters or fewer');
    }

    if (!USERNAME_PATTERN.test(trimmed)) {
        throw new Error(
            'Username may only contain letters, numbers, dots, underscores, and dashes',
        );
    }

    return trimmed;
}

function validatePassword(password: string): void {
    if (!password || password.length === 0) {
        throw new Error('Password is required');
    }

    if (password.length > 1024) {
        throw new Error('Password must be 1024 characters or fewer');
    }
}

function validateDisplayName(displayName: string | undefined): string | undefined {
    const trimmed = displayName?.trim();
    if (!trimmed) {
        return undefined;
    }

    if (trimmed.length > 128) {
        throw new Error('Display name must be 128 characters or fewer');
    }

    return trimmed;
}

async function hashPassword(password: string): Promise<{ hash: string; salt: string }> {
    const salt = crypto.getRandomValues(new Uint8Array(PASSWORD_SALT_BYTES));
    const hash = await derivePasswordHash(password, salt, PASSWORD_ITERATIONS);

    return {
        hash: toBase64(hash),
        salt: toBase64(salt),
    };
}

async function verifyPassword(password: string, user: AuthUser): Promise<boolean> {
    if (user.passwordAlgorithm !== PASSWORD_ALGORITHM) {
        return false;
    }

    const salt = fromBase64(user.passwordSalt);
    const expectedHash = fromBase64(user.passwordHash);
    const actualHash = await derivePasswordHash(password, salt, user.passwordIterations);

    return constantTimeEqual(actualHash, expectedHash);
}

async function derivePasswordHash(
    password: string,
    salt: Uint8Array,
    iterations: number,
): Promise<Uint8Array> {
    const keyMaterial = await crypto.subtle.importKey(
        'raw',
        new TextEncoder().encode(password),
        'PBKDF2',
        false,
        ['deriveBits'],
    );
    const bits = await crypto.subtle.deriveBits(
        {
            name: 'PBKDF2',
            hash: 'SHA-256',
            salt: toArrayBuffer(salt),
            iterations,
        },
        keyMaterial,
        PASSWORD_HASH_BITS,
    );

    return new Uint8Array(bits);
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
    const copy = new Uint8Array(bytes.length);
    copy.set(bytes);
    return copy.buffer;
}

function constantTimeEqual(left: Uint8Array, right: Uint8Array): boolean {
    if (left.length !== right.length) {
        return false;
    }

    let diff = 0;
    for (let index = 0; index < left.length; index += 1) {
        diff |= left[index] ^ right[index];
    }

    return diff === 0;
}

function toBase64(bytes: Uint8Array): string {
    let binary = '';
    for (const byte of bytes) {
        binary += String.fromCharCode(byte);
    }

    return btoa(binary);
}

function fromBase64(value: string): Uint8Array {
    return Uint8Array.from(atob(value), (char) => char.charCodeAt(0));
}
