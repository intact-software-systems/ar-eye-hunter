import { describe, expect, expectTypeOf, it } from 'vitest';

import { computeTopologyConfigMutation } from '@shared-server/rallar-system/topology/config/mutation/compute-topology-config-mutation.ts';
import type {
    GroupTopologyConfigGeneration,
    GroupTopologyConfigInvariantGeneration,
    GroupTopologyConfigMutationRecord
} from '@shared-server/rallar-system/topology/config/mutation/group-topology-config-mutation-contracts.ts';
import {
    readStoredTopologyConfigBoundary,
    readStoredTopologyOverrideBoundary,
    readTopologyConfigGenerationBoundary,
    readTopologyConfigInvariantGenerationBoundary,
    readTopologyConfigMutationRecordBoundary,
    readTopologyConfigReceiptBoundary
} from '@shared-server/rallar-system/topology/config/mutation/topology-config-mutation-boundary.ts';
import { validateTopologyConfigReceipt } from '@shared-server/rallar-system/topology/config/mutation/validate-topology-config-receipt.ts';
import {
    validateGroupTopologyConfigGeneration,
    validateGroupTopologyConfigInvariantGeneration,
    validateGroupTopologyConfigMutationRecord,
    validateStoredGroupTopologyConfig,
    validateStoredGroupTopologyOverride
} from '@shared-server/rallar-system/topology/config/mutation/validate-topology-config-records.ts';
import type {
    GroupTopologyConfigMutationReceipt,
    StoredGroupTopologyConfig,
    StoredGroupTopologyOverride
} from '@shared/api/graph-topology-management-types.ts';
import type { GroupRef } from '@shared/api/group-types.ts';
import { createTopologyConfigMutationTestInput } from './group-topology-config-mutation-test-fixtures.ts';

describe('topology config mutation raw boundaries', () => {
    it('owns complete operation validation before returning named domain contracts', () => {
        const fixtures = boundaryFixtures();
        expectGenericBoundaryRecordsRejected(fixtures.groupRef, fixtures.record.requestId);

        expect(() =>
            readTopologyConfigGenerationBoundary(
                { ...fixtures.generation, version: 0 },
                fixtures.groupRef,
                'config'
            )
        ).toThrow('Topology config generation version is invalid');
        expect(() =>
            readTopologyConfigInvariantGenerationBoundary(
                { ...fixtures.invariantGeneration, version: 0 },
                fixtures.groupRef
            )
        ).toThrow('Topology config invariant generation version is invalid');
        expect(() =>
            readStoredTopologyConfigBoundary(
                { ...fixtures.config, updatedAtEpochMs: fixtures.config.createdAtEpochMs - 1 },
                fixtures.groupRef
            )
        ).toThrow('Stored topology config updated before creation');
        expect(() =>
            readStoredTopologyOverrideBoundary(
                { ...fixtures.override, expiresAtEpochMs: fixtures.override.updatedAtEpochMs },
                fixtures.groupRef
            )
        ).toThrow('Stored topology override expiry must follow update');
        expect(() =>
            readTopologyConfigMutationRecordBoundary(
                { ...fixtures.record, receipt: null },
                { groupRef: fixtures.groupRef, requestId: fixtures.record.requestId }
            )
        ).toThrow('Topology config receipt is invalid');
        expect(() =>
            readTopologyConfigReceiptBoundary(
                { ...fixtures.receipt, operation: 'invalid-operation' },
                fixtures.groupRef
            )
        ).toThrow('Topology config receipt operation is invalid');
    });

    it('preserves the validated object identity at every raw handoff', () => {
        const fixtures = boundaryFixtures();

        expect(
            readTopologyConfigGenerationBoundary(fixtures.generation, fixtures.groupRef, 'config')
        ).toBe(fixtures.generation);
        expect(
            readTopologyConfigInvariantGenerationBoundary(
                fixtures.invariantGeneration,
                fixtures.groupRef
            )
        ).toBe(fixtures.invariantGeneration);
        expect(readStoredTopologyConfigBoundary(fixtures.config, fixtures.groupRef)).toBe(
            fixtures.config
        );
        expect(readStoredTopologyOverrideBoundary(fixtures.override, fixtures.groupRef)).toBe(
            fixtures.override
        );
        expect(
            readTopologyConfigMutationRecordBoundary(fixtures.record, {
                groupRef: fixtures.groupRef,
                requestId: fixtures.record.requestId
            })
        ).toBe(fixtures.record);
        expect(readTopologyConfigReceiptBoundary(fixtures.receipt, fixtures.groupRef)).toBe(
            fixtures.receipt
        );
    });

    it('hands only exact named contracts to typed continuation validators', () => {
        expectTypeOf<Record<string, unknown>>().not.toExtend<GroupTopologyConfigGeneration>();
        expectTypeOf<Record<string, unknown>>().not.toExtend<GroupTopologyConfigInvariantGeneration>();
        expectTypeOf<Record<string, unknown>>().not.toExtend<StoredGroupTopologyConfig>();
        expectTypeOf<Record<string, unknown>>().not.toExtend<StoredGroupTopologyOverride>();
        expectTypeOf<Record<string, unknown>>().not.toExtend<GroupTopologyConfigMutationRecord>();
        expectTypeOf<Record<string, unknown>>().not.toExtend<GroupTopologyConfigMutationReceipt>();
        expectTypeOf<ReturnType<typeof readTopologyConfigGenerationBoundary>>().toEqualTypeOf<GroupTopologyConfigGeneration>();
        expectTypeOf<ReturnType<typeof readTopologyConfigInvariantGenerationBoundary>>().toEqualTypeOf<GroupTopologyConfigInvariantGeneration>();
        expectTypeOf<ReturnType<typeof readStoredTopologyConfigBoundary>>().toEqualTypeOf<StoredGroupTopologyConfig>();
        expectTypeOf<ReturnType<typeof readStoredTopologyOverrideBoundary>>().toEqualTypeOf<StoredGroupTopologyOverride>();
        expectTypeOf<ReturnType<typeof readTopologyConfigMutationRecordBoundary>>().toEqualTypeOf<GroupTopologyConfigMutationRecord>();
        expectTypeOf<ReturnType<typeof readTopologyConfigReceiptBoundary>>().toEqualTypeOf<GroupTopologyConfigMutationReceipt>();
        expectTypeOf<Parameters<typeof validateGroupTopologyConfigGeneration>[0]>().toEqualTypeOf<GroupTopologyConfigGeneration>();
        expectTypeOf<Parameters<typeof validateGroupTopologyConfigInvariantGeneration>[0]>().toEqualTypeOf<GroupTopologyConfigInvariantGeneration>();
        expectTypeOf<Parameters<typeof validateStoredGroupTopologyConfig>[0]>().toEqualTypeOf<StoredGroupTopologyConfig>();
        expectTypeOf<Parameters<typeof validateStoredGroupTopologyOverride>[0]>().toEqualTypeOf<StoredGroupTopologyOverride>();
        expectTypeOf<Parameters<typeof validateGroupTopologyConfigMutationRecord>[0]>().toEqualTypeOf<GroupTopologyConfigMutationRecord>();
        expectTypeOf<Parameters<typeof validateTopologyConfigReceipt>[0]>().toEqualTypeOf<GroupTopologyConfigMutationReceipt>();
    });
});

function expectGenericBoundaryRecordsRejected(groupRef: GroupRef, requestId: string): void {
    const genericRecord: Record<string, unknown> = {};
    expect(() => readTopologyConfigGenerationBoundary(genericRecord, groupRef, 'config')).toThrow(
        'Topology config generation fields are invalid'
    );
    expect(() => readTopologyConfigInvariantGenerationBoundary(genericRecord, groupRef)).toThrow(
        'Topology config invariant generation fields are invalid'
    );
    expect(() => readStoredTopologyConfigBoundary(genericRecord, groupRef)).toThrow(
        'Stored topology config fields are invalid'
    );
    expect(() => readStoredTopologyOverrideBoundary(genericRecord, groupRef)).toThrow(
        'Stored topology config fields are invalid'
    );
    expect(() => readTopologyConfigMutationRecordBoundary(genericRecord, { groupRef, requestId })).toThrow(
        'Topology config mutation record fields are invalid'
    );
    expect(() => readTopologyConfigReceiptBoundary(genericRecord, groupRef)).toThrow(
        'Topology config receipt fields are invalid'
    );
}

function boundaryFixtures() {
    const mutation = createTopologyConfigMutationTestInput({
        durableDegreeLimit: 5,
        overrideDegreeLimit: 4
    });
    const computed = computeTopologyConfigMutation(mutation);
    if (computed.outcome !== 'write' || computed.idempotency === null) {
        throw new Error('Expected an idempotent topology config write');
    }
    const config = mutation.read.config?.value;
    const override = mutation.read.override?.value;
    if (!config || !override) {
        throw new Error('Expected stored topology config fixtures');
    }
    return {
        groupRef: mutation.command.aggregateRef,
        generation: {
            groupRef: mutation.command.aggregateRef,
            target: 'config',
            version: 1
        } satisfies GroupTopologyConfigGeneration,
        invariantGeneration: {
            groupRef: mutation.command.aggregateRef,
            version: 1
        } satisfies GroupTopologyConfigInvariantGeneration,
        config,
        override,
        record: computed.idempotency,
        receipt: computed.receipt
    };
}
