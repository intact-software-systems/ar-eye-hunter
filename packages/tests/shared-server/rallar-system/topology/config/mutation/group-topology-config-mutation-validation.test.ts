import { describe, expect, it } from 'vitest';

import type { AuditStamp } from '@shared/api/group-types.ts';

import { GroupTopologyConfigValidationError } from '@shared-server/rallar-system/topology/config/group-topology-config.ts';
import { computeTopologyConfigMutation } from '@shared-server/rallar-system/topology/config/mutation/compute-topology-config-mutation.ts';
import { validateTopologyConfigMutationPolicy } from '@shared-server/rallar-system/topology/config/mutation/validate-topology-config-mutation-policy.ts';
import { validateTopologyConfigMutation } from '@shared-server/rallar-system/topology/config/mutation/validate-topology-config-mutation.ts';
import { createDefaultTopologyConfigMutationTestInput } from './group-topology-config-mutation-test-fixtures.ts';

describe('topology config mutation validation', () => {
    it('rejects a candidate that differs from its deterministic recomputation', () => {
        const mutation = createDefaultTopologyConfigMutationTestInput();
        const computed = computeTopologyConfigMutation(mutation);
        if (computed.outcome !== 'write') {
            throw new Error('Expected topology config write');
        }

        const issues = validateTopologyConfigMutation({
            ...mutation,
            computed: { ...computed, receipt: { ...computed.receipt, attemptCount: 2 } }
        });
        expect(issues[0]?.cause).toHaveProperty('message', expect.stringMatching(/differs from the computed value/i));
    });

    it('rejects an invalid durable config even when a temporary override hides it until expiry', () => {
        const mutation = createDefaultTopologyConfigMutationTestInput({
            operation: 'putConfig',
            config: { meshParamK: 4 },
            durableDegreeLimit: 3,
            overrideDegreeLimit: 5
        });
        const input = {
            ...mutation,
            serverDefaults: { degreeLimit: 3, meshParamK: 2 }
        };
        const computed = computeTopologyConfigMutation(input);

        expect(validateTopologyConfigMutation({ ...input, computed })[0]?.cause).toBeInstanceOf(
            GroupTopologyConfigValidationError
        );
    });

    it('revalidates lifecycle authority at explicit attempt time', () => {
        const mutation = createDefaultTopologyConfigMutationTestInput();
        const expired = {
            ...mutation.read.groupSnapshot,
            group: { ...mutation.read.groupSnapshot.group, expiresAtEpochMs: 1_500 }
        };
        const input = {
            ...mutation,
            read: { ...mutation.read, groupSnapshot: expired },
            facts: { ...mutation.facts, isPlatformAdmin: true, policyNowEpochMs: 2_000 }
        };
        const issues = validateTopologyConfigMutationPolicy(input.command, input.read, input.facts);
        expect(issues).toEqual([
            expect.objectContaining({ code: 'group-not-active' })
        ]);
        expect(issues[0]?.cause).toMatchObject({ status: 403 });
    });

    it('collects all independent config and governance issues in deterministic order', () => {
        const mutation = createDefaultTopologyConfigMutationTestInput({ config: { degreeLimit: 0 } });
        const input = {
            ...mutation,
            command: {
                ...mutation.command,
                input: { ...mutation.command.input, updatedByPrincipalId: 'intruder' }
            },
            read: mutation.read,
            facts: mutation.facts
        };

        expect(validateTopologyConfigMutationPolicy(input.command, input.read, input.facts)).toEqual([
            expect.objectContaining({ code: 'invalid-positive-integer', path: ['degreeLimit'] }),
            expect.objectContaining({ code: 'member-not-active' })
        ]);
    });

    it('denies expired and terminal lifecycle mutations to platform admins', () => {
        const mutation = createDefaultTopologyConfigMutationTestInput({
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
            const input = {
                ...mutation,
                read: { ...mutation.read, groupSnapshot },
                facts: { ...mutation.facts, isPlatformAdmin: true, policyNowEpochMs: 2_000 }
            };
            const issues = validateTopologyConfigMutationPolicy(input.command, input.read, input.facts);
            expect(issues[0]?.cause).toMatchObject({
                status: 403,
                denial: expect.objectContaining({ code: denialCode })
            });
        }
    });

    it('rejects an elapsed stable override expiry from pure facts', () => {
        const mutation = createDefaultTopologyConfigMutationTestInput({
            operation: 'putOverride',
            commandId: 'elapsed-stable-expiry',
            requestId: 'elapsed-stable-expiry'
        });
        const input = {
            ...mutation,
            facts: { ...mutation.facts, policyNowEpochMs: 7_000 }
        };
        expect(validateTopologyConfigMutationPolicy(input.command, input.read, input.facts)).toEqual([
            expect.objectContaining({
                code: 'override-expiry-not-in-future',
                path: ['ttlMs']
            })
        ]);
    });

    it('rejects a missing computed override expiry during validation', () => {
        const mutation = createDefaultTopologyConfigMutationTestInput({ operation: 'putOverride' });
        const input = {
            ...mutation,
            facts: { ...mutation.facts, resolvedOverrideExpiresAtEpochMs: null }
        };
        const computed = computeTopologyConfigMutation(input);

        expect(validateTopologyConfigMutation({ ...input, computed })).toEqual([
            expect.objectContaining({ code: 'override-expiry-missing' })
        ]);
    });
});
