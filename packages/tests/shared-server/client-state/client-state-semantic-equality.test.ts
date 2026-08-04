import { describe, expect, it } from 'vitest';

import {
  isClientJsonObject,
  sameClientInstanceState,
  sameClientPrincipalRef,
  sameClientPrincipalState,
  sameClientSessionState,
} from '@shared-server/rallar-system/client-state/client-state-semantic-equality.ts';
import {
  isClientJsonObject as legacyIsClientJsonObject,
  sameClientPrincipalState as legacySameClientPrincipalState,
} from '@shared-server/rallar-system/services/client-state-semantic-equality.ts';

import {
  connectCommand,
  emptyRead,
  instanceCommand,
  principalCommand,
  readAfterWrite,
  requireWrite,
} from './client-mutation-compute-test-fixtures.ts';
import { computeClientMutation } from '@shared-server/rallar-system/client-state/mutation/compute/compute-client-mutation.ts';

describe('client state semantic equality', () => {
  it('treats object-key order as semantic but preserves array order', async () => {
    const command = await principalCommand();
    const principal = requireWrite(
      computeClientMutation({
        command,
        read: emptyRead(command),
      }),
    ).principal.value;

    expect(
      sameClientPrincipalState(principal, {
        ...principal,
        metadata: { nested: { enabled: true }, theme: 'dark' },
      }),
    ).toBe(false);
    expect(
      sameClientPrincipalState(
        { ...principal, metadata: { first: 1, second: 2 } },
        { ...principal, metadata: { second: 2, first: 1 } },
      ),
    ).toBe(true);
    expect(
      sameClientPrincipalState(
        { ...principal, roles: ['member', 'admin'] },
        { ...principal, roles: ['admin', 'member'] },
      ),
    ).toBe(false);
  });

  it('compares the exact principal, instance, and session semantic fields', async () => {
    const principalMutation = await principalCommand();
    const principalWrite = requireWrite(
      computeClientMutation({
        command: principalMutation,
        read: emptyRead(principalMutation),
      }),
    );
    const instanceMutation = await instanceCommand();
    const instanceWrite = requireWrite(
      computeClientMutation({
        command: instanceMutation,
        read: readAfterWrite(instanceMutation, principalWrite),
      }),
    );
    const connectMutation = await connectCommand();
    const connectWrite = requireWrite(
      computeClientMutation({
        command: connectMutation,
        read: emptyRead(connectMutation),
      }),
    );
    if (instanceWrite.instance.operation === 'none' || connectWrite.session.operation === 'none') {
      throw new Error('Expected instance and session candidates');
    }

    expect(sameClientPrincipalRef(principalWrite.principal.value, TEST_REF)).toBe(true);
    expect(
      sameClientInstanceState(instanceWrite.instance.value, { ...instanceWrite.instance.value }),
    ).toBe(true);
    expect(
      sameClientSessionState(connectWrite.session.value, {
        ...connectWrite.session.value,
        connectionId: 'different',
      }),
    ).toBe(false);
    expect(isClientJsonObject({})).toBe(true);
    expect(isClientJsonObject([])).toBe(false);
  });

  it('keeps legacy semantic exports as canonical identities', () => {
    expect(legacyIsClientJsonObject).toBe(isClientJsonObject);
    expect(legacySameClientPrincipalState).toBe(sameClientPrincipalState);
  });
});

const TEST_REF = {
  applicationId: 'app-1',
  workspaceId: 'workspace-1',
  principalId: 'alice',
};
