import { describe, expect, it } from 'vitest';

import {
  clientStateIdempotencyStorageKey,
  clientStateInstanceStorageKey,
  clientStatePrincipalStorageKey,
  clientStateSessionStorageKey,
  clientStateWorkspaceStorageKey,
  decodeClientIdempotencyStorageKey,
  decodeClientInstanceStorageKey,
  decodeClientPrincipalStorageKey,
  decodeClientSessionStorageKey,
} from '@shared-server/rallar-system/client-state/persistence/client-state-storage-keys.ts';
import { clientStateWorkspaceStorageKey as compatibilityClientStateWorkspaceStorageKey } from '@shared-server/rallar-system/client-state-storage-keys.ts';

const workspaceStorageKeys = [
  { workspaceId: '_', storageKey: '%5F' },
  { workspaceId: '%5F', storageKey: '%255F' },
  { workspaceId: 'a:b', storageKey: 'a%3Ab' },
  { workspaceId: 'a%b', storageKey: 'a%25b' },
  { workspaceId: 'a/b', storageKey: 'a%2Fb' },
  { workspaceId: 'default', storageKey: 'default' },
  { workspaceId: 'workspace-1', storageKey: 'workspace-1' },
] as const;

const clientStateStorageKeyDecoders = [
  { name: 'principal', decode: decodeClientPrincipalStorageKey },
  { name: 'instance', decode: decodeClientInstanceStorageKey },
  { name: 'session', decode: decodeClientSessionStorageKey },
  { name: 'idempotency', decode: decodeClientIdempotencyStorageKey },
] as const;

const noncanonicalClientStateStorageKeys = [
  {
    form: 'legacy workspace alias',
    keys: [
      'app=app:ws=_:principal=principal',
      'app=app:ws=_:principal=principal:instance=instance',
      'app=app:ws=_:principal=principal:instance=instance:session=session',
      'app=app:ws=_:principal=principal:request=request',
    ],
  },
  {
    form: 'lowercase escape',
    keys: [
      'app=app:ws=%5f:principal=principal',
      'app=app:ws=%5f:principal=principal:instance=instance',
      'app=app:ws=%5f:principal=principal:instance=instance:session=session',
      'app=app:ws=%5f:principal=principal:request=request',
    ],
  },
  {
    form: 'empty component',
    keys: [
      'app=app:ws=%5F:principal=',
      'app=app:ws=%5F:principal=principal:instance=',
      'app=app:ws=%5F:principal=principal:instance=instance:session=',
      'app=app:ws=%5F:principal=principal:request=',
    ],
  },
  {
    form: 'malformed escape',
    keys: [
      'app=%:ws=%5F:principal=principal',
      'app=%:ws=%5F:principal=principal:instance=instance',
      'app=%:ws=%5F:principal=principal:instance=instance:session=session',
      'app=%:ws=%5F:principal=principal:request=request',
    ],
  },
  {
    form: 'raw delimiter',
    keys: [
      'app=app:ws=%5F:principal=principal:raw',
      'app=app:ws=%5F:principal=principal:raw:instance=instance',
      'app=app:ws=%5F:principal=principal:raw:instance=instance:session=session',
      'app=app:ws=%5F:principal=principal:raw:request=request',
    ],
  },
  {
    form: 'unnecessary escape',
    keys: [
      'app=%61pp:ws=%5F:principal=principal',
      'app=%61pp:ws=%5F:principal=principal:instance=instance',
      'app=%61pp:ws=%5F:principal=principal:instance=instance:session=session',
      'app=%61pp:ws=%5F:principal=principal:request=request',
    ],
  },
] as const;

describe('client-state storage-key workspace injectivity', () => {
  it('encodes canonical workspace storage components', () => {
    for (const { workspaceId, storageKey } of workspaceStorageKeys) {
      expect(clientStateWorkspaceStorageKey(workspaceId)).toBe(storageKey);
    }
  });

  it('keeps every derived workspace key distinct and decodable', () => {
    const principals = workspaceStorageKeys.map(({ workspaceId }) => ({
      applicationId: 'app',
      workspaceId,
      principalId: 'principal',
    }));
    const instances = principals.map((principal) => ({
      ...principal,
      clientInstanceId: 'instance',
    }));
    const sessions = instances.map((instance) => ({ ...instance, sessionId: 'session' }));
    const requestId = 'request';

    const principalKeys = principals.map(clientStatePrincipalStorageKey);
    const instanceKeys = instances.map(clientStateInstanceStorageKey);
    const sessionKeys = sessions.map(clientStateSessionStorageKey);
    const idempotencyKeys = principals.map((principal) =>
      clientStateIdempotencyStorageKey(principal, requestId),
    );

    expect(new Set(principalKeys)).toHaveLength(principalKeys.length);
    expect(new Set(instanceKeys)).toHaveLength(instanceKeys.length);
    expect(new Set(sessionKeys)).toHaveLength(sessionKeys.length);
    expect(new Set(idempotencyKeys)).toHaveLength(idempotencyKeys.length);

    for (const [index, principal] of principals.entries()) {
      const instance = instances[index];
      const session = sessions[index];
      const principalKey = principalKeys[index];
      const instanceKey = instanceKeys[index];
      const sessionKey = sessionKeys[index];
      const idempotencyKey = idempotencyKeys[index];
      if (
        !instance ||
        !session ||
        !principalKey ||
        !instanceKey ||
        !sessionKey ||
        !idempotencyKey
      ) {
        throw new Error('Expected a storage key for every workspace');
      }
      expect(decodeClientPrincipalStorageKey(principalKey)).toEqual(principal);
      expect(decodeClientInstanceStorageKey(instanceKey)).toEqual(instance);
      expect(decodeClientSessionStorageKey(sessionKey)).toEqual(session);
      expect(decodeClientIdempotencyStorageKey(idempotencyKey)).toEqual({
        ...principal,
        requestId,
      });
    }
  });

  it('rejects missing and empty workspace components through the public helper', () => {
    const unsafeClientStateWorkspaceStorageKey = compatibilityClientStateWorkspaceStorageKey as (
      workspaceId?: string,
    ) => string;

    expect(() => unsafeClientStateWorkspaceStorageKey()).toThrow(TypeError);
    expect(() => unsafeClientStateWorkspaceStorageKey('')).toThrow(TypeError);
  });

  it('rejects literal noncanonical keys through every decoder', () => {
    for (const { form, keys } of noncanonicalClientStateStorageKeys) {
      for (const [index, key] of keys.entries()) {
        const decoder = clientStateStorageKeyDecoders[index];
        if (!decoder) {
          throw new Error('Expected one literal key for every client-state decoder');
        }
        expect(() => decoder.decode(key), `${decoder.name}: ${form}`).toThrow();
      }
    }
  });
});
