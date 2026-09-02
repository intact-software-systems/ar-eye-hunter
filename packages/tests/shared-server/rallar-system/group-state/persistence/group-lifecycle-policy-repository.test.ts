import { groupStateGroupStorageKey } from '@shared-server/rallar-system/group-state/persistence/aggregate/group-aggregate-storage-keys.ts';
import {
    decodeCurrentGroupLifecyclePolicy,
    validateCurrentGroupLifecyclePolicy
} from '@shared-server/rallar-system/group-state/persistence/decode-stored-group-lifecycle-policy.ts';
import {
    computeGroupLifecyclePolicyWrite,
    GROUP_LIFECYCLE_POLICIES_NAMESPACE,
    GroupLifecyclePolicyRepository
} from '@shared-server/rallar-system/group-state/persistence/group-lifecycle-policy-repository.ts';
import type { JsonWireValue } from '@shared-server/rallar-system/protocol/json-wire-identity.ts';
import { createDefaultGroupLifecyclePolicy, resolveGroupLifecyclePolicyPreset } from '@shared/api/group-lifecycle/group-lifecycle-policy-presets.ts';
import type { GroupRef } from '@shared/api/group-types.ts';
import { NEVER_EXPIRE_AT_TIMESTAMP } from '@shared/persistence/PersistenceProvider.ts';
import { describe, expect, it } from 'vitest';
import { FakeRuntimeStateRepository } from '../../../runtime-state/test-support/fake-runtime-state-repository.ts';

const GROUP: GroupRef = {
    applicationId: 'app-1',
    workspaceId: 'ws-1',
    groupId: 'group-1'
};

function createRepository(): GroupLifecyclePolicyRepository {
    return new GroupLifecyclePolicyRepository(new FakeRuntimeStateRepository());
}

async function storeRaw(
    repository: GroupLifecyclePolicyRepository,
    ref: GroupRef,
    value: JsonWireValue
): Promise<void> {
    await repository.runtimeRepository.upsert(
        GROUP_LIFECYCLE_POLICIES_NAMESPACE,
        groupStateGroupStorageKey(ref),
        JSON.stringify(value),
        NEVER_EXPIRE_AT_TIMESTAMP
    );
}

describe('GroupLifecyclePolicyRepository', () => {
    it('computes the same canonical persisted policy bytes regardless of input key order', () => {
        const original = resolveGroupLifecyclePolicyPreset('managed');
        const policy = {
            data: original.data,
            topology: original.topology,
            admission: original.admission,
            activation: original.activation,
            establishment: original.establishment,
            manager: original.manager,
            initiator: original.initiator,
            formation: original.formation
        };

        expect(computeGroupLifecyclePolicyWrite(GROUP, policy).value).toBe(
            '{"groupRef":{"applicationId":"app-1","workspaceId":"ws-1","groupId":"group-1"},' +
                '"policy":{"formation":"phased","initiator":"manager",' +
                '"manager":{"selection":"creator","assignedPrincipalIds":[],"count":1,"succession":"next-by-selection"},' +
                '"establishment":{"transports":"rtc-and-ws","maxConcurrentEdgeSetups":32,' +
                '"planTrigger":{"kind":"manual"},"connectTrigger":{"kind":"immediate"}},' +
                '"activation":{"mode":"threshold-or-deadline","successRate":0.95,"minimumViableRate":0.5,' +
                '"deadlineMs":30000,"maxFormationAttempts":3,"strictConfirmation":false},' +
                '"admission":{"mode":"manager-approval","untilEpochMs":null,"untilMemberCount":null},' +
                '"topology":{"replanning":"debounced","reconfigureLanding":"apply",' +
                '"debounceWindowMs":500,"maxReplanWaitMs":5000},"data":{"preActivationAppData":"allowed"}}}'
        );
    });

    it('collects independent persisted policy issues and preserves the decoder first error', () => {
        const policy = {
            ...createDefaultGroupLifecyclePolicy(),
            formation: 'unsupported',
            manager: null,
            topology: null
        };

        const issues = validateCurrentGroupLifecyclePolicy(policy);

        expect(issues.map((issue) => issue.cause.message)).toEqual(expect.arrayContaining([
            'Policy formation is invalid',
            'Group lifecycle manager policy must be an object',
            'Group lifecycle topology policy must be an object'
        ]));
        expect(() => decodeCurrentGroupLifecyclePolicy(policy)).toThrow('Policy formation is invalid');
    });

    it('keeps canonical policy decoding isolated from its accepted input', () => {
        const policy = resolveGroupLifecyclePolicyPreset('managed');
        expect(validateCurrentGroupLifecyclePolicy(policy)).toEqual([]);

        const decoded = decodeCurrentGroupLifecyclePolicy(policy);

        expect(decoded).toEqual(policy);
        expect(decoded).not.toBe(policy);
        expect(decoded.manager).not.toBe(policy.manager);
        expect(decoded.manager.assignedPrincipalIds).not.toBe(policy.manager.assignedPrincipalIds);
        expect(decoded.establishment.planTrigger).not.toBe(policy.establishment.planTrigger);
    });
    // Absent is the common case and has to stay cheap and unambiguous: every
    // group that exists today has no stored policy.
    it('reads an unwritten group as absent', async () => {
        expect(await createRepository().readPolicy(GROUP)).toEqual({ status: 'absent' });
    });

    it('round-trips a stored policy', async () => {
        const repository = createRepository();
        const policy = resolveGroupLifecyclePolicyPreset('managed');

        await storeRaw(repository, GROUP, { groupRef: GROUP, policy });

        expect(await repository.readPolicy(GROUP)).toEqual({ status: 'present', policy });
    });

    // No preset carries the timed trigger kinds, so without this the decoder's
    // per-variant key sets have no persistence-path coverage at all — a typo in
    // one variant list would ship green and read every such policy as corrupt.
    it('round-trips the timed trigger variants', async () => {
        const repository = createRepository();
        const policy = {
            ...resolveGroupLifecyclePolicyPreset('managed'),
            establishment: {
                ...resolveGroupLifecyclePolicyPreset('managed').establishment,
                planTrigger: { kind: 'after', settleMs: 2_000 } as const,
                connectTrigger: { kind: 'presence', memberCount: 4, fallbackMs: 10_000 } as const
            }
        };

        await storeRaw(repository, GROUP, { groupRef: GROUP, policy });

        expect(await repository.readPolicy(GROUP)).toEqual({ status: 'present', policy });
    });

    it('reports a trigger with a cross-variant key as corrupt', async () => {
        const repository = createRepository();
        const managed = resolveGroupLifecyclePolicyPreset('managed');

        await storeRaw(repository, GROUP, {
            groupRef: GROUP,
            policy: {
                ...managed,
                establishment: {
                    ...managed.establishment,
                    planTrigger: { kind: 'immediate', settleMs: 5 }
                }
            }
        });

        expect(await repository.readPolicy(GROUP)).toMatchObject({ status: 'corrupt' });
    });

    it('keeps policies of different groups apart', async () => {
        const repository = createRepository();
        const other: GroupRef = { ...GROUP, groupId: 'group-2' };

        await storeRaw(repository, GROUP, { groupRef: GROUP, policy: resolveGroupLifecyclePolicyPreset('match') });

        expect(await repository.readPolicy(other)).toEqual({ status: 'absent' });
    });

    // A row written under one group's key that carries another group's identity
    // is corruption, not an absent policy. Reporting it as absent would let a
    // closed group read as open.
    it('reports a foreign identity as corrupt rather than absent', async () => {
        const repository = createRepository();

        await storeRaw(repository, GROUP, {
            groupRef: { ...GROUP, groupId: 'someone-else' },
            policy: createDefaultGroupLifecyclePolicy()
        });

        const read = await repository.readPolicy(GROUP);

        expect(read.status).toBe('corrupt');
    });

    it.each([
        { label: 'a non-object policy', policy: 'not-a-policy' },
        { label: 'a null policy', policy: null }
    ])('reports $label as corrupt', async ({ policy }) => {
        const repository = createRepository();

        await storeRaw(repository, GROUP, { groupRef: GROUP, policy });

        expect((await repository.readPolicy(GROUP)).status).toBe('corrupt');
    });

    it('rejects extra persisted policy fields', async () => {
        const repository = createRepository();
        const policy = createDefaultGroupLifecyclePolicy();

        await storeRaw(repository, GROUP, {
            groupRef: GROUP,
            policy: { ...policy, unexpected: true }
        });

        expect(await repository.readPolicy(GROUP)).toMatchObject({ status: 'corrupt' });
    });

    it('rejects an incomplete persisted policy', async () => {
        const repository = createRepository();
        const { data: _missingData, ...incomplete } = createDefaultGroupLifecyclePolicy();

        await storeRaw(repository, GROUP, { groupRef: GROUP, policy: incomplete });

        expect(await repository.readPolicy(GROUP)).toMatchObject({ status: 'corrupt' });
    });

    it('rejects persisted values outside the current policy bounds', async () => {
        const repository = createRepository();
        const policy = createDefaultGroupLifecyclePolicy();

        await storeRaw(repository, GROUP, {
            groupRef: GROUP,
            policy: {
                ...policy,
                activation: { ...policy.activation, successRate: 2 }
            }
        });

        expect(await repository.readPolicy(GROUP)).toMatchObject({ status: 'corrupt' });
    });

    it('rejects an extra persisted row field', async () => {
        const repository = createRepository();

        await storeRaw(repository, GROUP, {
            groupRef: GROUP,
            policy: createDefaultGroupLifecyclePolicy(),
            unexpected: true
        });

        expect(await repository.readPolicy(GROUP)).toMatchObject({ status: 'corrupt' });
    });

    // A policy stored under rules it no longer satisfies is reported rather
    // than served. The enforcement point decides what to do; storage does not
    // quietly substitute a permissive default.
    it('reports a stored policy that no longer validates as corrupt', async () => {
        const repository = createRepository();
        const incoherent = {
            ...createDefaultGroupLifecyclePolicy(),
            initiator: 'manager',
            manager: {
                selection: 'none',
                assignedPrincipalIds: [],
                count: 1,
                succession: 'none'
            }
        };

        await storeRaw(repository, GROUP, { groupRef: GROUP, policy: incoherent });

        const read = await repository.readPolicy(GROUP);

        expect(read.status).toBe('corrupt');
        expect(read.status === 'corrupt' && read.reason).toContain('manager-initiator-without-manager');
    });

    it('overwrites a previously stored policy', async () => {
        const repository = createRepository();
        const replacement = resolveGroupLifecyclePolicyPreset('drop-in-social');

        await storeRaw(repository, GROUP, { groupRef: GROUP, policy: resolveGroupLifecyclePolicyPreset('match') });
        await storeRaw(repository, GROUP, { groupRef: GROUP, policy: replacement });

        expect(await repository.readPolicy(GROUP)).toEqual({ status: 'present', policy: replacement });
    });
});
