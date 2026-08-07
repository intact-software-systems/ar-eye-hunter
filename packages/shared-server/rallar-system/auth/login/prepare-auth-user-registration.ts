import type { RegisterRequest } from '@shared/api/api-config.ts';

import { normalizeUsername, type AuthUser } from '../persistence/auth-user-repository.ts';
import type { LoginClientData } from './authenticate-auth-user.ts';

const PASSWORD_ALGORITHM = 'pbkdf2-sha256' as const;
const PASSWORD_ITERATIONS = 120_000;
const PASSWORD_HASH_BITS = 256;
const PASSWORD_SALT_BYTES = 16;
const USERNAME_PATTERN = /^[a-zA-Z0-9._-]+$/;

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
  if (staticClients.some((client) => normalizeUsername(client.username) === normalizedUsername)) {
    throw new Error(`Auth user already exists: ${username}`);
  }
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

function validateUsername(username: string): string {
  const trimmed = username?.trim();
  if (!trimmed) {
    throw new Error('Username is required');
  }
  if (trimmed.length > 64) {
    throw new Error('Username must be 64 characters or fewer');
  }
  if (!USERNAME_PATTERN.test(trimmed)) {
    throw new Error('Username may only contain letters, numbers, dots, underscores, and dashes');
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

function toBase64(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary);
}
