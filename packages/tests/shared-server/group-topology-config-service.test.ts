import { describe, expect, expectTypeOf, it } from 'vitest';
import { readFileSync } from 'node:fs';
import type {
    PutGroupTopologyConfigRequest,
    PutGroupTopologyOverrideRequest,
} from '@shared/api/graph-topology-management-types.ts';
import {
    DEFAULT_GROUP_TOPOLOGY_OVERRIDE_TTL_MS,
    GroupTopologyConfigValidationError,
    MAX_GROUP_TOPOLOGY_OVERRIDE_TTL_MS,
    readDefaultGroupTopologyConfig,
    resolveGroupTopologyConfig,
    resolveOverrideExpiresAtEpochMs,
    validateEffectiveGroupTopologyConfig,
    validateGroupTopologyConfigPatch,
} from '@shared-server/rallar-system/services/group-topology-config-service.ts';
import {
    computeTopologyConfigMutation,
    validateGroupTopologyConfigMutationRecord,
    validateTopologyConfigMutation,
} from '@shared-server/rallar-system/services/group-topology-config-mutations.ts';

describe('group topology config service', () => {
    it('keeps synchronous reconfigure options off config mutation requests', () => {
        type ConfigHasReconfigure = 'reconfigure' extends
            keyof PutGroupTopologyConfigRequest ? true : false;
        type OverrideHasReconfigure = 'reconfigure' extends
            keyof PutGroupTopologyOverrideRequest ? true : false;
        expectTypeOf<ConfigHasReconfigure>().toEqualTypeOf<false>();
        expectTypeOf<OverrideHasReconfigure>().toEqualTypeOf<false>();
    });

    it('computes and validates the same immutable config mutation twice', () => {
        const input = deepFreeze({
            command: {
                operation: 'putConfig' as const,
                aggregateRef: createGroupRef(),
                commandId: 'config-command-1',
                requestId: 'config-command-1',
                input: {
                    config: { topologyKind: 'tree' as const, degreeLimit: 4 },
                    updatedByPrincipalId: 'owner',
                    ttlMs: null,
                    expiresAtEpochMs: null,
                },
            },
            read: {
                config: null,
                override: null,
                idempotency: null,
                groupSnapshot: createGroupSnapshot(),
            },
            facts: {
                requestedAtEpochMs: 1_000,
                policyNowEpochMs: 1_000,
                commandHash: `sha256:${'a'.repeat(64)}`,
                isPlatformAdmin: false,
                resolvedOverrideExpiresAtEpochMs: null,
                deleteTarget: null,
            },
            serverDefaults: {},
        });
        const before = structuredClone(input);

        const first = computeTopologyConfigMutation(input);
        const second = computeTopologyConfigMutation(input);
        const laterPolicyInput = deepFreeze({
            ...input,
            facts: { ...input.facts, policyNowEpochMs: 2_000 },
        });
        const laterPolicy = computeTopologyConfigMutation(laterPolicyInput);

        expect(first).toEqual(second);
        expect(laterPolicy).toEqual(first);
        expect(input).toEqual(before);
        expect(() => validateTopologyConfigMutation({ ...input, computed: first }))
            .not.toThrow();
        expect(() => validateTopologyConfigMutation({ ...input, computed: second }))
            .not.toThrow();
        expect(() =>
            validateTopologyConfigMutation({
                ...laterPolicyInput,
                computed: laterPolicy,
            })
        ).not.toThrow();
    });

    it.each(['putConfig', 'putOverride'] as const)(
        'rejects an impossible %s no-op receipt at the pure validator boundary',
        (operation) => {
            const groupRef = createGroupRef();
            const requestId = `impossible-${operation}`;
            const commandHash = `sha256:${'7'.repeat(64)}`;
            expect(() =>
                validateGroupTopologyConfigMutationRecord({
                    groupRef,
                    requestId,
                    commandHash,
                    receipt: {
                        commandId: requestId,
                        commandHash,
                        operation,
                        outcome: 'no-op',
                        groupRef,
                        target: operation === 'putConfig' ? 'config' : 'override',
                        acceptedVersion: 1,
                        acceptedStorageRevision: null,
                        acceptedCreatedAtEpochMs: 1_000,
                        acceptedUpdatedAtEpochMs: 1_000,
                        acceptedExpiresAtEpochMs: operation === 'putOverride'
                            ? 6_000
                            : null,
                        outboxId: null,
                    },
                }, { groupRef, requestId })
            ).toThrow('Topology config PUT receipt must be applied');
        },
    );

    it('rejects an elapsed stable override expiry with explicit pure facts', () => {
        const input = deepFreeze({
            command: {
                operation: 'putOverride' as const,
                aggregateRef: createGroupRef(),
                commandId: 'elapsed-stable-expiry',
                requestId: 'elapsed-stable-expiry',
                input: {
                    config: { topologyKind: 'tree' as const },
                    updatedByPrincipalId: 'owner',
                    ttlMs: 5_000,
                    expiresAtEpochMs: null,
                },
            },
            read: {
                config: null,
                override: null,
                configGeneration: null,
                overrideGeneration: null,
                invariantGeneration: null,
                idempotency: null,
                groupSnapshot: createGroupSnapshot(),
            },
            facts: {
                requestedAtEpochMs: 1_000,
                policyNowEpochMs: 7_000,
                commandHash: `sha256:${'8'.repeat(64)}`,
                isPlatformAdmin: false,
                resolvedOverrideExpiresAtEpochMs: 6_000,
                deleteTarget: null,
            },
            serverDefaults: {},
        });

        expect(() => computeTopologyConfigMutation(input)).toThrow(
            GroupTopologyConfigValidationError,
        );
    });

    it('keeps pure topology config phases ambient-free and orchestration visible', () => {
        const mutationSource = readFileSync(
            new URL(
                '../../shared-server/rallar-system/services/group-topology-config-mutations.ts',
                import.meta.url,
            ),
            'utf8',
        );
        for (const forbidden of [
            'Date.now',
            'Temporal.Now',
            'Math.random',
            'randomUUID',
            '.begin(',
            'new StateMutationOutboxRepository',
            'publisher',
            'topologyService',
        ]) {
            expect(mutationSource, forbidden).not.toContain(forbidden);
        }

        const serviceSource = readFileSync(
            new URL(
                '../../shared-server/rallar-system/services/group-topology-management-service.ts',
                import.meta.url,
            ),
            'utf8',
        );
        const read = serviceSource.indexOf('const read = await readTopologyConfigMutation');
        const compute = serviceSource.indexOf(
            'computed = computeTopologyConfigMutation',
            read,
        );
        const validate = serviceSource.indexOf('validateTopologyConfigMutation', compute);
        const write = serviceSource.indexOf(
            'written = await writeTopologyConfigMutation',
            validate,
        );
        expect(read).toBeGreaterThan(-1);
        expect(read).toBeLessThan(compute);
        expect(compute).toBeLessThan(validate);
        expect(validate).toBeLessThan(write);
        const writeHelper = serviceSource.indexOf(
            'async function writeTopologyConfigMutation',
        );
        const nextHelper = serviceSource.indexOf(
            'function topologyConfigExecution',
            writeHelper,
        );
        expect(writeHelper).toBeGreaterThan(write);
        expect(serviceSource.slice(writeHelper, nextHelper))
            .toContain('return await runtime.begin');
        expect(serviceSource.match(/\.begin\(/g)).toHaveLength(1);
        expect(serviceSource.slice(read, writeHelper)).not.toContain('.begin(');
    });

    it('resolves server defaults, durable config, temporary override, and request options', () => {
        const durable = {
            groupRef: createGroupRef(),
            config: {
                topologyKind: 'tree' as const,
                degreeLimit: 4,
            },
            version: 1,
            createdAtEpochMs: 1,
            updatedAtEpochMs: 1,
            updatedByPrincipalId: 'owner',
        };
        const temporary = {
            ...durable,
            config: {
                topologyKind: 'mesh' as const,
                meshMinSize: 20,
            },
            version: 2,
            expiresAtEpochMs: 10_000,
        };

        const view = resolveGroupTopologyConfig({
            serverOptions: {
                degreeLimit: 5,
                treeMinSize: 6,
                meshMinSize: 16,
                meshParamK: 2,
            },
            durable,
            temporary,
            requestOptions: {
                degreeLimit: 8,
            },
        });

        expect(view.serverDefaults).toEqual({
            topologyKind: 'auto',
            degreeLimit: 5,
            treeMinSize: 6,
            meshMinSize: 16,
            meshParamK: 2,
        });
        expect(view.effective).toEqual({
            topologyKind: 'mesh',
            degreeLimit: 8,
            treeMinSize: 6,
            meshMinSize: 20,
            meshParamK: 2,
        });
        expect(view.durable).toEqual(durable);
        expect(view.temporary).toEqual(temporary);
        expect(view.requestOptions).toEqual({ degreeLimit: 8 });
    });

    it('defaults server config to auto topology plus threshold defaults', () => {
        expect(readDefaultGroupTopologyConfig({})).toEqual({
            topologyKind: 'auto',
            degreeLimit: 5,
            treeMinSize: 5,
            meshMinSize: 16,
            meshParamK: 2,
        });
    });

    it('rejects invalid topology config patches and effective config combinations', () => {
        expect(() => validateGroupTopologyConfigPatch({ degreeLimit: 0 }))
            .toThrow(GroupTopologyConfigValidationError);
        expect(() => validateGroupTopologyConfigPatch({ treeMinSize: -1 }))
            .toThrow(GroupTopologyConfigValidationError);
        expect(() => validateGroupTopologyConfigPatch({ meshMinSize: 1.5 }))
            .toThrow(GroupTopologyConfigValidationError);

        expect(() =>
            validateEffectiveGroupTopologyConfig({
                topologyKind: 'auto',
                degreeLimit: 5,
                treeMinSize: 10,
                meshMinSize: 9,
                meshParamK: 2,
            })
        ).toThrow(GroupTopologyConfigValidationError);
        expect(() =>
            validateEffectiveGroupTopologyConfig({
                topologyKind: 'auto',
                degreeLimit: 3,
                treeMinSize: 5,
                meshMinSize: 16,
                meshParamK: 4,
            })
        ).toThrow(GroupTopologyConfigValidationError);
    });

    it('defaults temporary override expiry to 15 minutes and caps it at 24 hours', () => {
        expect(resolveOverrideExpiresAtEpochMs({ nowEpochMs: 1_000 }))
            .toBe(1_000 + DEFAULT_GROUP_TOPOLOGY_OVERRIDE_TTL_MS);
        expect(resolveOverrideExpiresAtEpochMs({
            nowEpochMs: 1_000,
            ttlMs: 5_000,
        })).toBe(6_000);
        expect(resolveOverrideExpiresAtEpochMs({
            nowEpochMs: 1_000,
            expiresAtEpochMs: 1_000 + MAX_GROUP_TOPOLOGY_OVERRIDE_TTL_MS + 10_000,
        })).toBe(1_000 + MAX_GROUP_TOPOLOGY_OVERRIDE_TTL_MS);
    });

    it('rejects temporary override expiries that are not in the future', () => {
        expect(() =>
            resolveOverrideExpiresAtEpochMs({
                nowEpochMs: 1_000,
                ttlMs: 0,
            })
        ).toThrow(GroupTopologyConfigValidationError);
        expect(() =>
            resolveOverrideExpiresAtEpochMs({
                nowEpochMs: 1_000,
                expiresAtEpochMs: 999,
            })
        ).toThrow(GroupTopologyConfigValidationError);
    });
});

function createGroupRef() {
    return {
        applicationId: 'app-1',
        workspaceId: 'workspace-1',
        groupId: 'room-1',
    };
}

function createGroupSnapshot() {
    const groupRef = createGroupRef();
    return {
        stateRevision: 1,
        causalRevision: { groupRevision: 1, presenceRevision: 0 },
        group: {
            ...groupRef,
            displayName: 'Room 1',
            kind: 'room' as const,
            status: 'active' as const,
            joinMode: 'open' as const,
            metadata: {},
            snapshotVersion: 1,
            metadataVersion: 0,
            rosterVersion: 1,
            presenceVersion: 0,
            activeMemberCount: 1,
            ownerPrincipalId: 'owner',
            created: { atEpochMs: 1, byPrincipalId: 'owner' },
            updated: { atEpochMs: 1, byPrincipalId: 'owner' },
        },
        members: [{
            ...groupRef,
            principalId: 'owner',
            role: 'owner' as const,
            status: 'active' as const,
            joined: { atEpochMs: 1, byPrincipalId: 'owner' },
            updated: { atEpochMs: 1, byPrincipalId: 'owner' },
        }],
        activeSessions: [],
        memberCount: 1,
        onlineMemberCount: 0,
    };
}

function deepFreeze<T>(value: T): T {
    if (value && typeof value === 'object') {
        Object.freeze(value);
        for (const nested of Object.values(value as Record<string, unknown>)) {
            deepFreeze(nested);
        }
    }
    return value;
}
