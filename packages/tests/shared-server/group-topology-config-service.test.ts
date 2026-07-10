import { describe, expect, it } from 'vitest';
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

describe('group topology config service', () => {
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
