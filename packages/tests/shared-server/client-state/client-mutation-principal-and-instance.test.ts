import { describe, expect, it } from 'vitest';

import { computeClientInstanceMutation } from '@shared-server/rallar-system/client-state/mutation/compute/compute-client-instance-mutation.ts';
import { computeClientMutation } from '@shared-server/rallar-system/client-state/mutation/compute/compute-client-mutation.ts';
import { computeClientPrincipalMutation } from '@shared-server/rallar-system/client-state/mutation/compute/compute-client-principal-mutation.ts';
import { computeClientMutation as legacyComputeClientMutation } from '@shared-server/rallar-system/services/client-state-mutations.ts';

import {
  emptyRead,
  instanceCommand,
  instanceFrom,
  principalCommand,
  readAfterWrite,
  requireWrite,
} from './client-mutation-compute-test-fixtures.ts';

describe('client principal and instance mutation compute', () => {
  it('creates the exact principal candidate through its named family owner', async () => {
    const command = await principalCommand();
    const read = emptyRead(command);

    const direct = computeClientPrincipalMutation({ command, read });
    const routed = computeClientMutation({ command, read });

    expect(routed).toEqual(direct);
    expect(requireWrite(routed)).toMatchObject({
      principal: {
        operation: 'insert',
        value: {
          username: 'alice',
          displayName: 'Alice',
          roles: ['member'],
          metadata: { theme: 'dark' },
          snapshotVersion: 1,
          profileVersion: 1,
          presenceVersion: 1,
        },
      },
      event: { eventType: 'principal-created' },
      snapshot: { stateRevision: 1, instances: [], activeSessions: [] },
    });
  });

  it('preserves semantic principal no-op and instance registration decisions', async () => {
    const firstCommand = await principalCommand('principal-seed');
    const first = requireWrite(
      computeClientMutation({
        command: firstCommand,
        read: emptyRead(firstCommand),
      }),
    );
    const sameCommand = await principalCommand('principal-same');
    const sameRead = readAfterWrite(sameCommand, first);

    expect(computeClientPrincipalMutation({ command: sameCommand, read: sameRead })).toMatchObject({
      outcome: 'no-op',
      persistIdempotency: true,
      event: null,
    });

    const nextCommand = await instanceCommand();
    const nextRead = readAfterWrite(nextCommand, first);
    const direct = computeClientInstanceMutation({ command: nextCommand, read: nextRead });
    expect(computeClientMutation({ command: nextCommand, read: nextRead })).toEqual(direct);
    expect(instanceFrom(requireWrite(direct))).toMatchObject({
      clientInstanceId: 'browser',
      platform: 'web',
      deviceLabel: 'Laptop',
      capabilities: ['rtc'],
    });
  });

  it('keeps the legacy dispatcher as the canonical function identity', () => {
    expect(legacyComputeClientMutation).toBe(computeClientMutation);
  });
});
