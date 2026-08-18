import { describe, expect, it } from 'vitest';

import type { AuditStamp } from '@shared/api/group-types.ts';

import { GroupTopologyConfigValidationError } from '@shared-server/rallar-system/topology/config/group-topology-config.ts';
import { computeTopologyConfigMutation } from '@shared-server/rallar-system/topology/config/mutation/compute-topology-config-mutation.ts';
import { validateTopologyConfigMutation } from '@shared-server/rallar-system/topology/config/mutation/validate-topology-config-mutation.ts';
import { createTopologyConfigMutationTestInput } from './group-topology-config-mutation-test-fixtures.ts';

describe('topology config mutation validation', () => {
  it('rejects a candidate that differs from its deterministic recomputation', () => {
    const mutation = createTopologyConfigMutationTestInput();
    const computed = computeTopologyConfigMutation(mutation);
    if (computed.outcome !== 'write') {
      throw new Error('Expected topology config write');
    }

    expect(() =>
      validateTopologyConfigMutation({
        ...mutation,
        computed: { ...computed, receipt: { ...computed.receipt, attemptCount: 2 } },
      }),
    ).toThrow(/differs from its canonical deterministic projection/i);
  });

  it('rejects an invalid durable config even when a temporary override hides it until expiry', () => {
    const mutation = createTopologyConfigMutationTestInput({
      operation: 'putConfig',
      config: { meshParamK: 4 },
      durableDegreeLimit: 3,
      overrideDegreeLimit: 5,
    });

    expect(() =>
      computeTopologyConfigMutation({
        ...mutation,
        serverDefaults: { degreeLimit: 3, meshParamK: 2 },
      }),
    ).toThrow(GroupTopologyConfigValidationError);
  });

  it('revalidates lifecycle authority at explicit attempt time', () => {
    const mutation = createTopologyConfigMutationTestInput();
    const expired = {
      ...mutation.read.groupSnapshot,
      group: { ...mutation.read.groupSnapshot.group, expiresAtEpochMs: 1_500 },
    };

    expect(() =>
      computeTopologyConfigMutation({
        ...mutation,
        read: { ...mutation.read, groupSnapshot: expired },
        facts: { ...mutation.facts, isPlatformAdmin: true, policyNowEpochMs: 2_000 },
      }),
    ).toThrow(expect.objectContaining({ status: 403 }));
  });

  it('denies expired and terminal lifecycle mutations to platform admins', () => {
    const mutation = createTopologyConfigMutationTestInput({
      operation: 'putConfig',
      config: { topologyKind: 'tree' },
      durableDegreeLimit: 5,
      overrideDegreeLimit: null,
    });
    const expired = {
      ...mutation.read.groupSnapshot,
      group: { ...mutation.read.groupSnapshot.group, expiresAtEpochMs: 1_500 },
    };
    const deleted: AuditStamp = {
      atEpochMs: 1_500,
      actor: { kind: 'principal', principalId: 'owner' },
      reason: null,
      traceId: null,
      requestId: null,
    };
    const terminal = {
      ...mutation.read.groupSnapshot,
      group: { ...mutation.read.groupSnapshot.group, status: 'deleted' as const, deleted },
    };

    for (const [groupSnapshot, denialCode] of [
      [expired, 'group-not-active'],
      [terminal, 'group-deleted'],
    ] as const) {
      expect(() =>
        computeTopologyConfigMutation({
          ...mutation,
          read: { ...mutation.read, groupSnapshot },
          facts: { ...mutation.facts, isPlatformAdmin: true, policyNowEpochMs: 2_000 },
        }),
      ).toThrow(
        expect.objectContaining({
          status: 403,
          denial: expect.objectContaining({ code: denialCode }),
        }),
      );
    }
  });

  it('rejects an elapsed stable override expiry from pure facts', () => {
    const mutation = createTopologyConfigMutationTestInput({
      operation: 'putOverride',
      commandId: 'elapsed-stable-expiry',
      requestId: 'elapsed-stable-expiry',
    });
    expect(() =>
      computeTopologyConfigMutation({
        ...mutation,
        facts: { ...mutation.facts, policyNowEpochMs: 7_000 },
      }),
    ).toThrow(GroupTopologyConfigValidationError);
  });
});
