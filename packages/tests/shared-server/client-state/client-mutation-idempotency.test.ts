import { describe, expect, it } from 'vitest';

import { computeClientMutation } from '@shared-server/rallar-system/client-state/mutation/compute/compute-client-mutation.ts';

import {
  emptyRead,
  entryValue,
  principalCommand,
  readAfterWrite,
  requireWrite,
} from './client-mutation-compute-test-fixtures.ts';

describe('client mutation idempotency compute', () => {
  it('replays the exact stored receipt, snapshot, and event', async () => {
    const command = await principalCommand();
    const applied = requireWrite(computeClientMutation({ command, read: emptyRead(command) }));
    if (!applied.idempotency) throw new Error('Expected idempotency record');
    const replayRead = {
      ...readAfterWrite(command, applied),
      idempotency: entryValue(applied.idempotency, 1),
    };

    expect(computeClientMutation({ command, read: replayRead })).toEqual({
      outcome: 'replay',
      receipt: applied.receipt,
      snapshot: applied.snapshot,
      event: applied.event,
    });
  });

  it('returns exact command hashes for conflicting idempotency content', async () => {
    const command = await principalCommand();
    const applied = requireWrite(computeClientMutation({ command, read: emptyRead(command) }));
    if (!applied.idempotency) throw new Error('Expected idempotency record');
    const conflicting = {
      ...command,
      facts: { ...command.facts, commandHash: `sha256:${'f'.repeat(64)}` },
    };
    const read = {
      ...readAfterWrite(conflicting, applied),
      idempotency: entryValue(applied.idempotency, 1),
    };

    expect(computeClientMutation({ command: conflicting, read })).toEqual({
      outcome: 'idempotency-conflict',
      existingCommandHash: command.facts.commandHash,
      receivedCommandHash: conflicting.facts.commandHash,
    });
  });
});
