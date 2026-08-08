import { describe, expect, it } from 'vitest';

import { computeTopologyConfigMutation } from '@shared-server/rallar-system/topology/config/mutation/compute-topology-config-mutation.ts';
import {
  probeTopologyConfigMutationIdempotency,
  validateTopologyConfigMutationIdempotency,
} from '@shared-server/rallar-system/topology/config/mutation/topology-config-mutation-idempotency.ts';
import { createTopologyConfigMutationTestInput } from './group-topology-config-mutation-test-fixtures.ts';

describe('topology config mutation idempotency', () => {
  it('returns a durable replay for the same command hash', () => {
    const mutation = createTopologyConfigMutationTestInput();
    const accepted = computeTopologyConfigMutation(mutation);
    if (accepted.outcome !== 'write' || accepted.idempotency === null) {
      throw new Error('Expected an idempotent topology config write');
    }
    const read = {
      ...mutation.read,
      idempotency: runtimeEntry(accepted.idempotency),
    };
    const replay = probeTopologyConfigMutationIdempotency(
      mutation.command,
      read,
      mutation.facts.commandHash,
    );

    expect(replay).toMatchObject({ outcome: 'replay', receipt: accepted.receipt });
    expect(() =>
      validateTopologyConfigMutationIdempotency({
        command: mutation.command,
        read,
        commandHash: mutation.facts.commandHash,
        authorityFacts: { isPlatformAdmin: false },
        computed: replay as never,
      }),
    ).not.toThrow();
  });

  it('returns a typed conflict for divergent same-request semantics', () => {
    const mutation = createTopologyConfigMutationTestInput();
    const accepted = computeTopologyConfigMutation(mutation);
    if (accepted.outcome !== 'write' || accepted.idempotency === null) {
      throw new Error('Expected an idempotent topology config write');
    }
    const conflict = probeTopologyConfigMutationIdempotency(
      mutation.command,
      { ...mutation.read, idempotency: runtimeEntry(accepted.idempotency) },
      `sha256:${'d'.repeat(64)}`,
    );

    expect(conflict).toEqual({
      outcome: 'idempotency-conflict',
      existingCommandHash: mutation.facts.commandHash,
      receivedCommandHash: `sha256:${'d'.repeat(64)}`,
    });
  });

  it('rejects compact replay receipt operation corruption against the verified command', () => {
    const mutation = createTopologyConfigMutationTestInput();
    const accepted = computeTopologyConfigMutation(mutation);
    if (accepted.outcome !== 'write') throw new Error('Expected topology config write');
    const corruptRecord = {
      groupRef: mutation.command.aggregateRef,
      requestId: mutation.command.requestId!,
      commandHash: mutation.facts.commandHash,
      receipt: {
        ...accepted.receipt,
        operation: 'putOverride' as const,
        target: 'override' as const,
        acceptedExpiresAtEpochMs: accepted.receipt.acceptedUpdatedAtEpochMs! + 1,
      },
    };
    const read = { ...mutation.read, idempotency: runtimeEntry(corruptRecord) };

    expect(() =>
      probeTopologyConfigMutationIdempotency(mutation.command, read, mutation.facts.commandHash),
    ).toThrow('Topology config receipt operation differs from command');
  });
});

function runtimeEntry<T>(value: T) {
  return {
    key: 'idempotency',
    value,
    entry: {
      key: 'idempotency',
      value: JSON.stringify(value),
      expireAtTimestamp: Number.MAX_SAFE_INTEGER,
      updatedTimestamp: new Date(0).toISOString(),
      revision: 0,
    },
  };
}
