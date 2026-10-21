import { validateStoredGroup } from '@shared-server/rallar-system/group-state/persistence/validate-persisted-group.ts';
import type { Group } from '@shared/api/group-types.ts';
import { describe, expect, it } from 'vitest';

import { createTestGroup } from '../../../../create-test-group.ts';

const GROUP_REF = {
    applicationId: 'app-1',
    workspaceId: 'workspace-1',
    groupId: 'group-1'
} as const;

// Stored rows are parsed without a separate JSON-safety pass, so the typed validator is what
// rejects the numbers JSON.stringify never writes: negative zero and overflowed literals.
describe('stored group JSON numbers', () => {
    it('accepts a stored group with a formation outcome and an activation status', () => {
        expect(() => validateStoredGroup(storedGroup(), GROUP_REF)).not.toThrow();
    });

    it.each([
        ['presenceVersion', (group: Group) => ({ ...group, presenceVersion: -0 })],
        ['formationEpoch', (group: Group) => ({ ...group, formationEpoch: -0 })],
        [
            'lastFormationOutcome observedRate',
            (group: Group) => ({ ...group, lastFormationOutcome: { ...group.lastFormationOutcome!, observedRate: -0 } })
        ],
        [
            'activationStatus coverageRate',
            (group: Group) => ({ ...group, activationStatus: { ...group.activationStatus!, coverageRate: -0 } })
        ],
        [
            'activationStatus formationEpoch',
            (group: Group) => ({ ...group, activationStatus: { ...group.activationStatus!, formationEpoch: -0 } })
        ]
    ])('rejects negative zero in %s', (_field, corrupt) => {
        expect(() => validateStoredGroup(corrupt(storedGroup()), GROUP_REF)).toThrow(TypeError);
    });

    it.each([
        ['an overflowed number', { score: Number.POSITIVE_INFINITY }],
        ['negative zero', { score: -0 }],
        ['a nested non-finite number', { nested: { samples: [1, Number.NEGATIVE_INFINITY] } }]
    ])('rejects metadata holding %s', (_case, metadata) => {
        expect(() => validateStoredGroup({ ...storedGroup(), metadata }, GROUP_REF)).toThrow(TypeError);
    });
});

function storedGroup(): Group {
    return createTestGroup({
        ...GROUP_REF,
        metadata: { score: 1.5, tags: ['a'], nested: { ready: true } },
        formationEpoch: 1,
        lastFormationOutcome: { outcome: 'activated', observedRate: 0, atEpochMs: 1_000, formationEpoch: 1 },
        activationStatus: {
            condition: 'inactive',
            coverageRate: 0,
            coverageBasisLayoutIdentity: { groupRevision: 1, presenceRevision: 0, version: 1, state: 'active' },
            formationEpoch: 1,
            evidenceWatermark: null,
            publishedAtEpochMs: 1_000
        }
    });
}
