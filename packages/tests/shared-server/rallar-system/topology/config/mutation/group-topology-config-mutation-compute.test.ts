import { computeTopologyConfigMutation } from '@shared-server/rallar-system/topology/config/mutation/compute-topology-config-mutation.ts';
import type { TopologyConfigMutationInput } from '@shared-server/rallar-system/topology/config/mutation/group-topology-config-mutation-contracts.ts';
import { validateTopologyConfigMutation } from '@shared-server/rallar-system/topology/config/mutation/validate-topology-config-mutation.ts';
import { validateGroupTopologyConfigMutationRecord } from '@shared-server/rallar-system/topology/config/mutation/validate-topology-config-records.ts';
import type { GroupTopologyConfigMutationReceipt } from '@shared/api/graph-topology-management-types.ts';
import { describe, expect, it } from 'vitest';
import {
    createTopologyConfigMutationTestInput,
    createTopologyTestAuthorityGuard,
    createTopologyTestGroupRef,
    createTopologyTestGroupSnapshot,
    deepFreezeTopologyTestValue
} from './group-topology-config-mutation-test-fixtures.ts';

describe('group topology config mutation compute', () => {
    it('computes and validates the same immutable config mutation twice', () => {
        const input = deterministicMutationInput();
        const before = structuredClone(input);

        const first = computeTopologyConfigMutation(input);
        const second = computeTopologyConfigMutation(input);
        const laterPolicyInput = deepFreezeTopologyTestValue({
            ...input,
            facts: { ...input.facts, policyNowEpochMs: 2_000 }
        });
        const laterPolicy = computeTopologyConfigMutation(laterPolicyInput);

        expect(first).toEqual(second);
        expect(laterPolicy).toEqual(first);
        expect(input).toEqual(before);
        expect(() => validateTopologyConfigMutation({ ...input, computed: first })).not.toThrow();
        expect(() => validateTopologyConfigMutation({ ...input, computed: second })).not.toThrow();
        expect(() =>
            validateTopologyConfigMutation({
                ...laterPolicyInput,
                computed: laterPolicy
            })
        ).not.toThrow();

        if (first.outcome !== 'write') {
            throw new Error('Expected an applied topology config mutation');
        }
        expect(first.runtimeWrites.map((write) => write.operation)).toEqual([
            'update',
            'insert',
            'insert',
            'insert',
            'insert'
        ]);
        for (const write of first.runtimeWrites) {
            expect(write.key.length).toBeGreaterThan(0);
            expect(write.namespace.length).toBeGreaterThan(0);
            if (write.operation !== 'delete') {
                expect(() => JSON.parse(write.value)).not.toThrow();
            }
        }
        const expected = { groupRef: input.command.aggregateRef, requestId: 'config-command-1' };
        const record = { ...expected, commandHash: input.facts.commandHash, receipt: first.receipt };
        expect(() =>
            validateGroupTopologyConfigMutationRecord({
                ...record,
                receipt: { ...first.receipt, outboxIds: ['state-mutation-attacker-selected'] }
            }, expected)
        ).toThrow('Topology config receipt outbox identity is invalid');
        expect(() =>
            validateGroupTopologyConfigMutationRecord({
                ...record,
                receipt: { ...first.receipt, acceptedConfig: null }
            }, expected)
        ).toThrow('accepted config does not match operation');
        expect(() =>
            validateGroupTopologyConfigMutationRecord({
                ...record,
                receipt: {
                    ...first.receipt,
                    acceptedConfig: { topologyKind: 'tree' } as GroupTopologyConfigMutationReceipt['acceptedConfig']
                }
            }, expected)
        ).toThrow('accepted config fields are invalid');
    });

    it('clears durable and override fields back to their immediate fallback', () => {
        const durableInput = createTopologyConfigMutationTestInput({
            operation: 'putConfig',
            config: { degreeLimit: null },
            durableDegreeLimit: 9,
            overrideDegreeLimit: null
        });
        const durable = computeTopologyConfigMutation(durableInput);
        if (durable.outcome !== 'write' || durable.result.kind !== 'config') {
            throw new Error('Expected durable config write');
        }
        expect(durable.result.config.config.degreeLimit).toBe(5);

        const overrideInput = createTopologyConfigMutationTestInput({
            operation: 'putOverride',
            config: { degreeLimit: null },
            durableDegreeLimit: 4,
            overrideDegreeLimit: 9
        });
        const override = computeTopologyConfigMutation(overrideInput);
        if (override.outcome !== 'write' || override.result.kind !== 'override') {
            throw new Error('Expected topology override write');
        }
        expect(override.result.override.config.degreeLimit).toBe(4);
    });
});

function deterministicMutationInput(): TopologyConfigMutationInput {
    return deepFreezeTopologyTestValue({
        command: {
            operation: 'putConfig' as const,
            aggregateRef: createTopologyTestGroupRef(),
            commandId: 'config-command-1',
            requestId: 'config-command-1',
            input: {
                config: { topologyKind: 'tree' as const, degreeLimit: 4 },
                updatedByPrincipalId: 'owner',
                ttlMs: null,
                expiresAtEpochMs: null
            }
        },
        read: {
            config: null,
            override: null,
            configGeneration: null,
            overrideGeneration: null,
            invariantGeneration: null,
            idempotency: null,
            groupSnapshot: createTopologyTestGroupSnapshot(),
            groupAuthorityGuard: createTopologyTestAuthorityGuard(40)
        },
        facts: {
            requestedAtEpochMs: 1_000,
            policyNowEpochMs: 1_000,
            commandHash: `sha256:${'a'.repeat(64)}`,
            attemptCount: 1,
            isPlatformAdmin: false,
            resolvedOverrideExpiresAtEpochMs: null
        },
        serverDefaults: {}
    });
}
