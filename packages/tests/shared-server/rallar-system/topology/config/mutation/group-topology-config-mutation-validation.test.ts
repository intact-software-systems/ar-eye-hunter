// dprint-ignore
import {
    describe,
    expect,
    it
} from 'vitest';

import type { AuditStamp } from '@shared/api/group-types.ts';

import { GroupTopologyConfigValidationError } from '@shared-server/rallar-system/topology/config/group-topology-config.ts';
import { computeTopologyConfigMutation } from '@shared-server/rallar-system/topology/config/mutation/compute-topology-config-mutation.ts';
import type { TopologyConfigMutationInput } from '@shared-server/rallar-system/topology/config/mutation/group-topology-config-mutation-contracts.ts';
import { validateTopologyConfigMutation } from '@shared-server/rallar-system/topology/config/mutation/validate-topology-config-mutation.ts';
import type { RuntimeStateEntryValue } from '@shared-server/runtime-state/runtime-state-json-store.ts';
import { createTopologyConfigMutationTestInput } from './group-topology-config-mutation-test-fixtures.ts';

describe('topology config mutation validation', () => {
    it.each(['proxy', 'accessor'] as const)('rejects a behavior-bearing %s candidate without invoking it', (kind) => {
        const mutation = createTopologyConfigMutationTestInput();
        const computed = computeTopologyConfigMutation(mutation);
        let calls = 0;
        const candidate = kind === 'proxy'
            ? new Proxy(computed, {
                get(target, key, receiver) {
                    calls += 1;
                    return Reflect.get(target, key, receiver);
                }
            })
            : Object.defineProperty({ ...computed }, 'outcome', {
                enumerable: true,
                get() {
                    calls += 1;
                    return computed.outcome;
                }
            });
        expect(() => validateTopologyConfigMutation({ ...mutation, computed: candidate })).toThrow(TypeError);
        expect(calls).toBe(0);
    });

    it.each(
        (['write', 'claim'] as const).flatMap((outcome) => [-0, Number.MAX_SAFE_INTEGER].map((revision) => ({ outcome, revision })))
    )('rejects original authority revision $revision for $outcome', ({ outcome, revision }) => {
        const original = createTopologyConfigMutationTestInput();
        const mutation: TopologyConfigMutationInput = {
            ...original,
            command: outcome === 'claim'
                ? { ...original.command, operation: 'deleteConfig', input: { ...original.command.input, config: null } }
                : original.command,
            read: {
                ...original.read,
                groupAuthorityGuard: {
                    ...original.read.groupAuthorityGuard,
                    entry: { ...original.read.groupAuthorityGuard.entry, revision }
                }
            }
        };
        const computed = computeTopologyConfigMutation(mutation);
        expect(computed.outcome).toBe(outcome);
        expect(() => validateTopologyConfigMutation({ ...mutation, computed })).toThrow(
            new Error(`Invalid runtime state upsert expected revision: ${revision}`)
        );
    });

    it.each(['configGeneration', 'overrideGeneration', 'invariantGeneration'] as const)(
        'rejects an overflowing original %s update guard',
        (field) => {
            const mutation = createGenerationRevisionInput(field, Number.MAX_SAFE_INTEGER);
            const computed = computeTopologyConfigMutation(mutation);
            expect(computed.outcome).toBe('write');
            expect(() => validateTopologyConfigMutation({ ...mutation, computed })).toThrow(
                new Error(`Invalid runtime state upsert expected revision: ${Number.MAX_SAFE_INTEGER}`)
            );
        }
    );

    it.each(['configGeneration', 'overrideGeneration', 'invariantGeneration'] as const)(
        'accepts the last incrementable %s guard',
        (field) => {
            const mutation = createGenerationRevisionInput(field, Number.MAX_SAFE_INTEGER - 1);
            expect(() => validateTopologyConfigMutation({ ...mutation, computed: computeTopologyConfigMutation(mutation) })).not.toThrow();
        }
    );

    it('allows deletion at MAX without requiring the deleted row to increment', () => {
        const original = createTopologyConfigMutationTestInput({ durableDegreeLimit: 5 });
        if (original.read.config === null) {
            throw new Error('Expected an existing config');
        }
        const mutation: TopologyConfigMutationInput = {
            ...original,
            command: { ...original.command, operation: 'deleteConfig', input: { ...original.command.input, config: null } },
            read: {
                ...original.read,
                config: { ...original.read.config, entry: { ...original.read.config.entry, revision: Number.MAX_SAFE_INTEGER } }
            }
        };
        const computed = computeTopologyConfigMutation(mutation);
        if (computed.outcome !== 'write') {
            throw new Error('Expected a config deletion');
        }
        expect(computed.guard).toMatchObject({ operation: 'delete', expectedRevision: Number.MAX_SAFE_INTEGER });
        expect(() => validateTopologyConfigMutation({ ...mutation, computed })).not.toThrow();
    });

    it('rejects a candidate that differs from its deterministic recomputation', () => {
        const mutation = createTopologyConfigMutationTestInput();
        const computed = computeTopologyConfigMutation(mutation);
        if (computed.outcome !== 'write') {
            throw new Error('Expected topology config write');
        }

        expect(() =>
            validateTopologyConfigMutation({
                ...mutation,
                computed: { ...computed, receipt: { ...computed.receipt, attemptCount: 2 } }
            })
        ).toThrow(/differs from its canonical deterministic projection/i);
    });

    it('rejects an invalid durable config even when a temporary override hides it until expiry', () => {
        const mutation = createTopologyConfigMutationTestInput({
            operation: 'putConfig',
            config: { meshParamK: 4 },
            durableDegreeLimit: 3,
            overrideDegreeLimit: 5
        });

        expect(() =>
            computeTopologyConfigMutation({
                ...mutation,
                serverDefaults: { degreeLimit: 3, meshParamK: 2 }
            })
        ).toThrow(GroupTopologyConfigValidationError);
    });

    it('revalidates lifecycle authority at explicit attempt time', () => {
        const mutation = createTopologyConfigMutationTestInput();
        const expired = {
            ...mutation.read.groupSnapshot,
            group: { ...mutation.read.groupSnapshot.group, expiresAtEpochMs: 1_500 }
        };

        expect(() =>
            computeTopologyConfigMutation({
                ...mutation,
                read: { ...mutation.read, groupSnapshot: expired },
                facts: { ...mutation.facts, isPlatformAdmin: true, policyNowEpochMs: 2_000 }
            })
        ).toThrow(expect.objectContaining({ status: 403 }));
    });

    it('denies expired and terminal lifecycle mutations to platform admins', () => {
        const mutation = createTopologyConfigMutationTestInput({
            operation: 'putConfig',
            config: { topologyKind: 'tree' },
            durableDegreeLimit: 5,
            overrideDegreeLimit: null
        });
        const expired = {
            ...mutation.read.groupSnapshot,
            group: { ...mutation.read.groupSnapshot.group, expiresAtEpochMs: 1_500 }
        };
        const deleted: AuditStamp = {
            atEpochMs: 1_500,
            actor: { kind: 'principal', principalId: 'owner' },
            reason: null,
            traceId: null,
            requestId: null
        };
        const terminal = {
            ...mutation.read.groupSnapshot,
            group: { ...mutation.read.groupSnapshot.group, status: 'deleted' as const, deleted }
        };

        for (
            const [groupSnapshot, denialCode] of [
                [expired, 'group-not-active'],
                [terminal, 'group-deleted']
            ] as const
        ) {
            expect(() =>
                computeTopologyConfigMutation({
                    ...mutation,
                    read: { ...mutation.read, groupSnapshot },
                    facts: { ...mutation.facts, isPlatformAdmin: true, policyNowEpochMs: 2_000 }
                })
            ).toThrow(
                expect.objectContaining({
                    status: 403,
                    denial: expect.objectContaining({ code: denialCode })
                })
            );
        }
    });

    it('rejects an elapsed stable override expiry from pure facts', () => {
        const mutation = createTopologyConfigMutationTestInput({
            operation: 'putOverride',
            commandId: 'elapsed-stable-expiry',
            requestId: 'elapsed-stable-expiry'
        });
        expect(() =>
            computeTopologyConfigMutation({
                ...mutation,
                facts: { ...mutation.facts, policyNowEpochMs: 7_000 }
            })
        ).toThrow(GroupTopologyConfigValidationError);
    });
});

function createGenerationRevisionInput(
    field: 'configGeneration' | 'overrideGeneration' | 'invariantGeneration',
    revision: number
): TopologyConfigMutationInput {
    const mutation = createTopologyConfigMutationTestInput({ operation: field === 'overrideGeneration' ? 'putOverride' : 'putConfig' });
    const groupRef = mutation.command.aggregateRef;
    const value = field === 'invariantGeneration'
        ? { groupRef, version: 1 }
        : { groupRef, version: 1, target: field === 'configGeneration' ? 'config' as const : 'override' as const };
    return { ...mutation, read: { ...mutation.read, [field]: createRevisionEntry(field, value, revision) } };
}

function createRevisionEntry<T>(key: string, value: T, revision: number): RuntimeStateEntryValue<T> {
    return {
        value,
        entry: {
            key,
            value: JSON.stringify(value),
            revision,
            expireAtTimestamp: Number.MAX_SAFE_INTEGER,
            updatedTimestamp: '1970-01-01T00:00:00.000Z'
        }
    };
}
