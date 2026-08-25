import { computeTopologyConfigMutation } from '@shared-server/rallar-system/topology/config/mutation/compute-topology-config-mutation.ts';
import { validateTopologyConfigMutation } from '@shared-server/rallar-system/topology/config/mutation/validate-topology-config-mutation.ts';
import { validateGroupTopologyConfigMutationRecord } from '@shared-server/rallar-system/topology/config/mutation/validate-topology-config-records.ts';
import { readFileSync } from 'node:fs';
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
        expect(() =>
            validateMutationRecord(input, {
                ...first.receipt,
                outboxIds: ['state-mutation-attacker-selected']
            })
        ).toThrow('Topology config receipt outbox identity is invalid');
        expect(() => validateMutationRecord(input, { ...first.receipt, acceptedConfig: null })).toThrow(
            'accepted config does not match operation'
        );
        expect(() =>
            validateMutationRecord(input, {
                ...first.receipt,
                acceptedConfig: { topologyKind: 'tree' } as WriteReceipt['acceptedConfig']
            })
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

    it('keeps pure topology config phases ambient-free and orchestration visible', () => {
        const mutationSource = readProductionSource(
            'topology/config/mutation/compute-topology-config-mutation.ts'
        );
        for (
            const forbidden of [
                'Date.now',
                'Temporal.Now',
                'Math.random',
                'randomUUID',
                '.begin(',
                'hashMutationCommand',
                'publisher',
                'topologyService'
            ]
        ) {
            expect(mutationSource, forbidden).not.toContain(forbidden);
        }

        const writerSource = readProductionSource(
            'topology/config/mutation/write-topology-config-mutation.ts'
        );
        const appInboxSource = readProductionSource('topology/inbox/topology-app-inbox-handler.ts');
        const read = appInboxSource.indexOf('const read = await owners.configMutationService.read');
        const compute = appInboxSource.indexOf(
            'const computed = owners.configMutationService.compute',
            read
        );
        const validate = appInboxSource.indexOf('owners.configMutationService.validate', compute);
        const transaction = appInboxSource.indexOf(
            'const result = await this.dependencies.transactionWriter.writeMutation',
            validate
        );
        const write = appInboxSource.indexOf('configMutationService.write(', transaction);
        expect(read).toBeGreaterThan(-1);
        expect(read).toBeLessThan(compute);
        expect(compute).toBeLessThan(validate);
        expect(validate).toBeLessThan(transaction);
        expect(transaction).toBeLessThan(write);
        const writeHelper = writerSource.indexOf('export async function writeTopologyConfigMutation');
        expect(writeHelper).toBeGreaterThan(-1);
        const writer = writerSource.slice(writeHelper);
        expect(writerSource).toContain('readonly transaction: PSqlSql');
        expect(writer).not.toContain('.begin(');
        expect(appInboxSource.slice(read, write)).not.toContain('.begin(');
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
            resolvedOverrideExpiresAtEpochMs: null,
            deleteTarget: null
        },
        serverDefaults: {}
    });
}

function validateMutationRecord(input: DeterministicMutationInput, receipt: WriteReceipt) {
    return validateGroupTopologyConfigMutationRecord(
        {
            groupRef: input.command.aggregateRef,
            requestId: input.command.requestId,
            commandHash: input.facts.commandHash,
            receipt
        },
        {
            groupRef: input.command.aggregateRef,
            requestId: input.command.requestId
        }
    );
}

function readProductionSource(relativePath: string): string {
    return readFileSync(
        new URL(`../../../../../../shared-server/rallar-system/${relativePath}`, import.meta.url),
        'utf8'
    );
}
