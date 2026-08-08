import { describe, expect, it } from 'vitest';

import { computeTopologyConfigMutation } from '@shared-server/rallar-system/topology/config/mutation/compute-topology-config-mutation.ts';
import { resultFromTopologyConfigReceipt } from '@shared-server/rallar-system/topology/config/mutation/topology-config-mutation-receipt.ts';
import { validateGroupTopologyConfigMutationRecord } from '@shared-server/rallar-system/topology/config/mutation/validate-topology-config-records.ts';
import {
  createTopologyConfigMutationTestInput,
  createTopologyTestGroupRef,
} from './group-topology-config-mutation-test-fixtures.ts';

describe('topology config mutation result reconstruction', () => {
  it.each(['putConfig', 'putOverride'] as const)(
    'reconstructs the exact %s result from its durable receipt',
    (operation) => {
      const mutation = createTopologyConfigMutationTestInput({ operation });
      const computed = computeTopologyConfigMutation(mutation);
      if (computed.outcome !== 'write') throw new Error('Expected topology config write');

      expect(resultFromTopologyConfigReceipt(mutation.command, computed.receipt)).toEqual(
        computed.result,
      );
    },
  );

  it('preserves delete no-op reconstruction without an outbox', () => {
    const mutation = createTopologyConfigMutationTestInput();
    const command = {
      ...mutation.command,
      operation: 'deleteConfig' as const,
      input: { ...mutation.command.input, config: null },
    };
    const computed = computeTopologyConfigMutation({ ...mutation, command });

    expect(computed).toMatchObject({
      outcome: 'claim',
      receipt: { outcome: 'no-op', eventId: null, outboxId: null, outboxIds: [] },
      result: { kind: 'delete', deleted: false },
    });
  });

  it.each(['putConfig', 'putOverride'] as const)(
    'rejects an impossible %s no-op receipt at the pure validator boundary',
    (operation) => {
      const groupRef = createTopologyTestGroupRef();
      const requestId = `impossible-${operation}`;
      const commandHash = `sha256:${'7'.repeat(64)}`;
      expect(() =>
        validateGroupTopologyConfigMutationRecord(
          {
            groupRef,
            requestId,
            commandHash,
            receipt: {
              commandId: requestId,
              requestId,
              commandHash,
              operation,
              outcome: 'no-op',
              attemptCount: 1,
              groupRef,
              target: operation === 'putConfig' ? 'config' : 'override',
              acceptedVersion: 1,
              acceptedStorageRevision: null,
              acceptedCreatedAtEpochMs: 1_000,
              acceptedUpdatedAtEpochMs: 1_000,
              acceptedExpiresAtEpochMs: operation === 'putOverride' ? 6_000 : null,
              acceptedConfig: {
                topologyKind: 'tree',
                degreeLimit: 5,
                treeMinSize: 5,
                meshMinSize: 16,
                meshParamK: 2,
              },
              acceptedCausalRevision: null,
              eventId: null,
              outboxId: null,
              outboxIds: [],
            },
          },
          { groupRef, requestId },
        ),
      ).toThrow('Topology config PUT receipt must be applied');
    },
  );
});
