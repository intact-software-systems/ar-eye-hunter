import { assertGroupTopologyConfigMutationRecord } from '@shared-server/rallar-system/topology/config/mutation/assert-topology-config-records.ts';
import { computeTopologyConfigMutation } from '@shared-server/rallar-system/topology/config/mutation/compute-topology-config-mutation.ts';
import { validateTopologyConfigMutation } from '@shared-server/rallar-system/topology/config/mutation/validate-topology-config-mutation.ts';
import { describe, expect, it } from 'vitest';
import {
    createDefaultTopologyConfigMutationTestInput,
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
        expect(validateTopologyConfigMutation({ ...input, computed: first })).toEqual([]);
        expect(validateTopologyConfigMutation({ ...input, computed: second })).toEqual([]);
        expect(validateTopologyConfigMutation({
            ...laterPolicyInput,
            computed: laterPolicy
        })).toEqual([]);

        if (first.outcome !== 'write') {
            throw new Error('Expected an applied topology config mutation');
        }
        expect(() =>
            assertMutationRecord(input, {
                ...first.receipt,
                outboxIds: ['state-mutation-attacker-selected']
            })
        ).toThrow('Topology config receipt outbox identity is invalid');
        expect(() => assertMutationRecord(input, { ...first.receipt, acceptedConfig: null })).toThrow(
            'accepted config does not match operation'
        );
        expect(() =>
            assertMutationRecord(input, {
                ...first.receipt,
                acceptedConfig: { topologyKind: 'tree' } as WriteReceipt['acceptedConfig']
            })
        ).toThrow('accepted config fields are invalid');
    });

    it('clears durable and override fields back to their immediate fallback', () => {
        const durableInput = createDefaultTopologyConfigMutationTestInput({
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

        const overrideInput = createDefaultTopologyConfigMutationTestInput({
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

type DeterministicMutationInput = ReturnType<typeof deterministicMutationInput>;
type WriteMutation = Extract<ReturnType<typeof computeTopologyConfigMutation>, Readonly<{ outcome: 'write'; }>>;
type WriteReceipt = WriteMutation['receipt'];

function deterministicMutationInput() {
    return deepFreezeTopologyTestValue({
        command: {
            operation: 'putConfig' as const,
            aggregateRef: createTopologyTestGroupRef(),
            commandId: 'config-command-1',
            requestId: 'config-command-1',
            commandHash: `sha256:${'a'.repeat(64)}`,
            capturedAtEpochMs: 1_000,
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
            policyNowEpochMs: 1_000,
            attemptCount: 1,
            isPlatformAdmin: false,
            resolvedOverrideExpiresAtEpochMs: null,
            deleteTarget: null
        },
        serverDefaults: {}
    });
}

function assertMutationRecord(input: DeterministicMutationInput, receipt: WriteReceipt) {
    return assertGroupTopologyConfigMutationRecord(
        {
            groupRef: input.command.aggregateRef,
            requestId: input.command.requestId,
            commandHash: input.command.commandHash,
            receipt
        },
        {
            groupRef: input.command.aggregateRef,
            requestId: input.command.requestId
        }
    );
}
