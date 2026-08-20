import type { LoginRequest } from '@shared/api/api-config.ts';

import {
  AuthUserRepository,
  normalizeUsername,
  type AuthUser,
} from '../persistence/auth-user-repository.ts';
import type { IssueAuthSessionCommand } from '../mutation/auth-mutation-contracts.ts';

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
const PASSWORD_HASH_BITS = 256;

export async function authenticateAuthUser(
  loginRequest: LoginRequest,
  options: LoginAuthUserOptions,
): Promise<AuthenticatedUserIdentity | undefined> {
  const normalizedUsername = normalizeUsername(loginRequest.username);
  const registeredUser =
    await options.userRepository.findByNormalizedUsernameEntry(normalizedUsername);
  if (registeredUser) {
    if (
      registeredUser.value.status !== 'active' ||
      !(await verifyAuthUserPassword(loginRequest.password, registeredUser.value))
    ) {
      return undefined;
    }
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

export async function verifyAuthUserPassword(
  password: string,
  user: AuthUser,
): Promise<boolean> {
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

function fromBase64(value: string): Uint8Array {
  return Uint8Array.from(atob(value), (char) => char.charCodeAt(0));
}
