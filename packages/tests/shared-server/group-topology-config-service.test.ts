import { describe, expect, expectTypeOf, it } from 'vitest';
import { readFileSync } from 'node:fs';
import type {
    PutGroupTopologyConfigRequest,
    PutGroupTopologyOverrideRequest,
} from '@shared/api/graph-topology-management-types.ts';
import type { GroupSnapshot } from '@shared/api/group-types.ts';
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
                configGeneration: null,
                overrideGeneration: null,
                invariantGeneration: null,
                idempotency: null,
                groupSnapshot: createGroupSnapshot(),
                groupAuthorityGuard: createGroupAuthorityGuard(),
            },
            facts: {
                requestedAtEpochMs: 1_000,
                policyNowEpochMs: 1_000,
                commandHash: `sha256:${'a'.repeat(64)}`,
                attemptCount: 1,
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

        if (first.outcome !== 'write') {
            throw new Error('Expected an applied topology config mutation');
        }
        expect(() => validateGroupTopologyConfigMutationRecord({
            groupRef: input.command.aggregateRef,
            requestId: input.command.requestId,
            commandHash: input.facts.commandHash,
            receipt: {
                ...first.receipt,
                outboxId: 'state-mutation-attacker-selected',
            },
        }, {
            groupRef: input.command.aggregateRef,
            requestId: input.command.requestId,
        })).toThrow('Topology config receipt outboxIds are invalid');
        expect(() => validateGroupTopologyConfigMutationRecord({
            groupRef: input.command.aggregateRef,
            requestId: input.command.requestId,
            commandHash: input.facts.commandHash,
            receipt: { ...first.receipt, acceptedConfig: null },
        }, {
            groupRef: input.command.aggregateRef,
            requestId: input.command.requestId,
        })).toThrow('accepted config does not match operation');
        expect(() => validateGroupTopologyConfigMutationRecord({
            groupRef: input.command.aggregateRef,
            requestId: input.command.requestId,
            commandHash: input.facts.commandHash,
            receipt: {
                ...first.receipt,
                acceptedConfig: { topologyKind: 'tree' },
            },
        }, {
            groupRef: input.command.aggregateRef,
            requestId: input.command.requestId,
        })).toThrow('accepted config fields are invalid');
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
                        acceptedExpiresAtEpochMs: operation === 'putOverride'
                            ? 6_000
                            : null,
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
                groupAuthorityGuard: createGroupAuthorityGuard(),
            },
            facts: {
                requestedAtEpochMs: 1_000,
                policyNowEpochMs: 7_000,
                commandHash: `sha256:${'8'.repeat(64)}`,
                attemptCount: 1,
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

        const managementSource = readFileSync(
            new URL(
                '../../shared-server/rallar-system/services/group-topology-management-service.ts',
                import.meta.url,
            ),
            'utf8',
        );
        const appInboxSource = readFileSync(
            new URL(
                '../../shared-server/rallar-system/services/AppGroupInboxService.ts',
                import.meta.url,
            ),
            'utf8',
        );
        const read = appInboxSource.indexOf(
            'const read = await service.readTopologyConfigMutation',
        );
        const compute = appInboxSource.indexOf(
            'const computed = service.computeTopologyConfigMutation',
            read,
        );
        const validate = appInboxSource.indexOf(
            'service.validateTopologyConfigMutation',
            compute,
        );
        const transaction = appInboxSource.indexOf(
            'const result = await this.writeMutation',
            validate,
        );
        const write = appInboxSource.indexOf(
            'await service.writeTopologyConfigMutation',
            transaction,
        );
        expect(read).toBeGreaterThan(-1);
        expect(read).toBeLessThan(compute);
        expect(compute).toBeLessThan(validate);
        expect(validate).toBeLessThan(transaction);
        expect(transaction).toBeLessThan(write);
        const writeHelper = managementSource.indexOf(
            'export async function writeTopologyConfigMutation',
        );
        expect(writeHelper).toBeGreaterThan(-1);
        const writer = managementSource.slice(writeHelper);
        expect(writer).toContain('transaction: PSqlTransactionSql');
        expect(writer).not.toContain('.begin(');
        expect(appInboxSource.slice(read, write)).not.toContain('.begin(');
    });

    it('resolves server defaults, durable config, temporary override, and request options', () => {
        const durable = {
            groupRef: createGroupRef(),
            config: {
                topologyKind: 'tree' as const,
                degreeLimit: 4,
                treeMinSize: 6,
                meshMinSize: 16,
                meshParamK: 2,
            },
            version: 1,
            createdAtEpochMs: 1,
            updatedAtEpochMs: 1,
            updatedByPrincipalId: 'owner',
            requestId: 'durable-config',
        };
        const temporary = {
            ...durable,
            config: {
                topologyKind: 'mesh' as const,
                degreeLimit: 4,
                treeMinSize: 6,
                meshMinSize: 20,
                meshParamK: 2,
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

function createGroupSnapshot(): GroupSnapshot {
    const groupRef = createGroupRef();
    return {
        stateRevision: 1,
        causalRevision: { groupRevision: 1, presenceRevision: 0 },
        group: {
            ...groupRef,
            slug: null,
            displayName: 'Room 1',
            description: null,
            kind: 'room' as const,
            status: 'active' as const,
            archived: null,
            deleted: null,
            joinMode: 'open' as const,
            maxMembers: null,
            maxSessionsPerMember: null,
            metadata: {},
            snapshotVersion: 1,
            metadataVersion: 0,
            rosterVersion: 1,
            presenceVersion: 0,
            activeMemberCount: 1,
            ownerPrincipalId: 'owner',
            expiresAtEpochMs: null,
            emptySinceEpochMs: null,
            purgeAfterEpochMs: null,
            created: {
                atEpochMs: 1,
                actor: { kind: 'principal', principalId: 'owner' },
                reason: null,
                traceId: null,
                requestId: null,
            },
            updated: {
                atEpochMs: 1,
                actor: { kind: 'principal', principalId: 'owner' },
                reason: null,
                traceId: null,
                requestId: null,
            },
        },
        members: [{
            ...groupRef,
            principalId: 'owner',
            role: 'owner' as const,
            status: 'active' as const,
            invitedByPrincipalId: null,
            invitationExpiresAtEpochMs: null,
            left: null,
            removed: null,
            banned: null,
            joined: {
                atEpochMs: 1,
                actor: { kind: 'principal', principalId: 'owner' },
                reason: null,
                traceId: null,
                requestId: null,
            },
            updated: {
                atEpochMs: 1,
                actor: { kind: 'principal', principalId: 'owner' },
                reason: null,
                traceId: null,
                requestId: null,
            },
        }],
        activeSessions: [],
        memberCount: 1,
        onlineMemberCount: 0,
    };
}

function createGroupAuthorityGuard() {
    const group = createGroupSnapshot().group;
    return {
        groupRef: createGroupRef(),
        causalGroupRevision: 1,
        entry: {
            key: 'group-authority',
            value: JSON.stringify(group),
            expireAtTimestamp: Number.MAX_SAFE_INTEGER,
            updatedTimestamp: new Date(0).toISOString(),
            revision: 0,
        },
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
