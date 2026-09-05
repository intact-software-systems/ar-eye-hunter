import type { PutGroupTopologyConfigRequest, PutGroupTopologyOverrideRequest } from '@shared/api/graph-topology-management-types.ts';
import { describe, expect, expectTypeOf, it } from 'vitest';

import {
    computeOverrideExpiresAtEpochMs,
    DEFAULT_GROUP_TOPOLOGY_OVERRIDE_TTL_MS,
    GroupTopologyConfigValidationError,
    MAX_GROUP_TOPOLOGY_OVERRIDE_TTL_MS,
    resolveDefaultGroupTopologyConfig,
    resolveGroupTopologyConfig,
    resolveOverrideExpiresAtEpochMs,
    validateEffectiveGroupTopologyConfig,
    validateGroupTopologyConfigPatch
} from '@shared-server/rallar-system/topology/config/group-topology-config.ts';

describe('group topology config resolution', () => {
    it('keeps synchronous reconfigure options off config mutation requests', () => {
        type ConfigHasReconfigure = 'reconfigure' extends keyof PutGroupTopologyConfigRequest ? true :
            false;
        type OverrideHasReconfigure = 'reconfigure' extends keyof PutGroupTopologyOverrideRequest ? true :
            false;
        expectTypeOf<ConfigHasReconfigure>().toEqualTypeOf<false>();
        expectTypeOf<OverrideHasReconfigure>().toEqualTypeOf<false>();
    });

    it('resolves defaults, durable config, temporary override, and request options in order', () => {
        const durable = storedConfig('tree', 4, 16);
        const temporary = { ...storedConfig('mesh', 4, 20), version: 2, expiresAtEpochMs: 10_000 };
        const view = resolveGroupTopologyConfig({
            serverOptions: { degreeLimit: 5, treeMinSize: 6, meshMinSize: 16, meshParamK: 2 },
            durable,
            temporary,
            requestOptions: { degreeLimit: 8 }
        });

        expect(view.serverDefaults).toEqual({
            topologyKind: 'auto',
            degreeLimit: 5,
            treeMinSize: 6,
            meshMinSize: 16,
            meshParamK: 2
        });
        expect(view.effective).toEqual({
            topologyKind: 'mesh',
            degreeLimit: 8,
            treeMinSize: 6,
            meshMinSize: 20,
            meshParamK: 2
        });
        expect(view.durable).toEqual(durable);
        expect(view.temporary).toEqual(temporary);
        expect(view.requestOptions).toEqual({ degreeLimit: 8 });
    });

    it('preserves default values and rejects invalid patches and effective combinations', () => {
        expect(resolveDefaultGroupTopologyConfig({})).toEqual({
            topologyKind: 'auto',
            degreeLimit: 5,
            treeMinSize: 5,
            meshMinSize: 16,
            meshParamK: 2
        });
        expect(validateGroupTopologyConfigPatch({ degreeLimit: 0 })).toEqual([
            expect.objectContaining({ code: 'invalid-positive-integer', path: ['degreeLimit'] })
        ]);
        expect(validateGroupTopologyConfigPatch({ treeMinSize: -1 })).toEqual([
            expect.objectContaining({ code: 'invalid-positive-integer', path: ['treeMinSize'] })
        ]);
        expect(validateGroupTopologyConfigPatch({ meshMinSize: 1.5 })).toEqual([
            expect.objectContaining({ code: 'invalid-positive-integer', path: ['meshMinSize'] })
        ]);
        expect(
            validateEffectiveGroupTopologyConfig({
                topologyKind: 'auto',
                degreeLimit: 0,
                treeMinSize: 10,
                meshMinSize: 9,
                meshParamK: 11
            })
        ).toEqual([
            expect.objectContaining({ code: 'invalid-positive-integer', path: ['degreeLimit'] }),
            expect.objectContaining({
                code: 'mesh-min-size-before-tree-min-size',
                path: ['meshMinSize']
            }),
            expect.objectContaining({
                code: 'mesh-param-k-exceeds-degree-limit',
                path: ['meshParamK']
            })
        ]);
    });

    it('defaults override expiry to 15 minutes, caps it at 24 hours, and rejects elapsed values', () => {
        expect(computeOverrideExpiresAtEpochMs({ nowEpochMs: 1_000, ttlMs: 0 })).toBe(1_000);
        expect(resolveOverrideExpiresAtEpochMs({ nowEpochMs: 1_000 })).toBe(
            1_000 + DEFAULT_GROUP_TOPOLOGY_OVERRIDE_TTL_MS
        );
        expect(resolveOverrideExpiresAtEpochMs({ nowEpochMs: 1_000, ttlMs: 5_000 })).toBe(6_000);
        expect(
            resolveOverrideExpiresAtEpochMs({
                nowEpochMs: 1_000,
                expiresAtEpochMs: 1_000 + MAX_GROUP_TOPOLOGY_OVERRIDE_TTL_MS + 10_000
            })
        ).toBe(1_000 + MAX_GROUP_TOPOLOGY_OVERRIDE_TTL_MS);
        expect(() => resolveOverrideExpiresAtEpochMs({ nowEpochMs: 1_000, ttlMs: 0 })).toThrow(
            GroupTopologyConfigValidationError
        );
        expect(() => resolveOverrideExpiresAtEpochMs({ nowEpochMs: 1_000, expiresAtEpochMs: 999 })).toThrow(GroupTopologyConfigValidationError);
    });
});

function storedConfig(topologyKind: 'tree' | 'mesh', degreeLimit: number, meshMinSize: number) {
    return {
        groupRef: { applicationId: 'app-1', workspaceId: 'workspace-1', groupId: 'room-1' },
        config: { topologyKind, degreeLimit, treeMinSize: 6, meshMinSize, meshParamK: 2 },
        version: 1,
        createdAtEpochMs: 1,
        updatedAtEpochMs: 1,
        updatedByPrincipalId: 'owner',
        requestId: 'durable-config'
    };
}
