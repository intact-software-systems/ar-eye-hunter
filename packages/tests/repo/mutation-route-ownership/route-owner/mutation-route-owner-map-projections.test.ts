import { describe, expect, it } from 'vitest';

import { findMutationBoundaryViolationsFromRoots } from '../boundary/mutation-boundary-analysis.ts';
import { MUTATION_ROUTE_INVENTORY, validateMutationRouteInventory } from '../routing/mutation-routing-inventory.ts';
import { readGroupOwnerAnchors } from './mutation-route-owner-anchors.ts';

const FIXTURES = 'packages/tests/repo/mutation-route-ownership/fixtures/mutation-boundary-capability-receivers';
const GROUP_OWNER = 'packages/shared-server/rallar-system/group-state/inbox/group-state-inbox-service.ts';
const {
    source: GROUP_OWNER_SOURCE,
    collection: LIVE_GROUP_COLLECTION
} = readGroupOwnerAnchors();

describe('Mutation route owner map projections contracts', () => {
    it.each([
        'c10-object-alias.ts',
        'c10-computed-object-alias.ts',
        'c10-assigned-object.ts',
        'c10-factory-return.ts',
        'c10-conditional-object.ts',
        'c10-logical-object.ts'
    ])('propagates local callable object values in %s', (name) => {
        expectMutation(name);
    });

    it.each(['c10-factory-capability-assignment.ts', 'c10-imported-factory-capability.ts'])(
        'does not skip capability provenance introduced by a typed factory in %s',
        (name) => {
            expectMutation(name);
        }
    );

    it.each([
        'c10-control-read-only-object.ts',
        'c10-control-never-called-object.ts',
        'c10-control-mutual-return-cycle.ts',
        'c10-control-no-capability-cycle.ts'
    ])('keeps benign callable object control clean in %s', (name) => {
        expect(findMutationBoundaryViolationsFromRoots([`${FIXTURES}/${name}`])).toEqual([]);
    });

    it.each([
        'c10-callback-invoke.ts',
        'c10-callback-conditional.ts',
        'c10-callback-forward.ts',
        'c10-callback-external.ts',
        'c10-callback-external-object.ts'
    ])('applies only reachable callback effects in %s', (name) => {
        expectMutation(name);
    });

    it.each(['c10-control-callback-ignore.ts', 'c10-control-callback-external.ts'])(
        'keeps benign callback control clean in %s',
        (name) => {
            expect(findMutationBoundaryViolationsFromRoots([`${FIXTURES}/${name}`])).toEqual([]);
        }
    );

    it('projects only keys from a Map', () => {
        const issues = validateWithGroupCollection(
            'new Map([[AppInboxType.GROUP_CREATE, AppInboxType.GROUP_UPDATE]]).keys()'
        );
        expectConnected(issues, 'GROUP_CREATE');
        expectMissing(issues, 'GROUP_UPDATE');
    });

    it('projects only values from a Map', () => {
        const issues = validateWithGroupCollection(
            'new Map([[AppInboxType.GROUP_CREATE, AppInboxType.GROUP_UPDATE]]).values()'
        );
        expectMissing(issues, 'GROUP_CREATE');
        expectConnected(issues, 'GROUP_UPDATE');
    });

    it('projects a Map entry key through exact destructuring', () => {
        const issues = validateWithGroupCollection(
            `[...new Map([[AppInboxType.GROUP_CREATE, AppInboxType.GROUP_UPDATE]]).entries()]
        .map(([type]) => type)`
        );
        expectConnected(issues, 'GROUP_CREATE');
        expectMissing(issues, 'GROUP_UPDATE');
    });

    it('projects a Map entry value through exact destructuring', () => {
        const issues = validateWithGroupCollection(
            `[...new Map([[AppInboxType.GROUP_CREATE, AppInboxType.GROUP_UPDATE]]).entries()]
        .map(([, type]) => type)`
        );
        expectMissing(issues, 'GROUP_CREATE');
        expectConnected(issues, 'GROUP_UPDATE');
    });

    it('resolves an aliased Map before projecting keys', () => {
        const issues = validateWithGroupCollection(
            'TYPE_MAP.keys()',
            `const TYPE_MAP = new Map([
        [AppInboxType.GROUP_CREATE, AppInboxType.GROUP_UPDATE],
      ]);`
        );
        expectConnected(issues, 'GROUP_CREATE');
        expectMissing(issues, 'GROUP_UPDATE');
    });

    it('resolves a provable computed Map projection method', () => {
        const issues = validateWithGroupCollection(
            'TYPE_MAP[MAP_METHOD]()',
            `const TYPE_MAP = new Map([
        [AppInboxType.GROUP_CREATE, AppInboxType.GROUP_UPDATE],
      ]);
      const MAP_METHOD = 'values';`
        );
        expectMissing(issues, 'GROUP_CREATE');
        expectConnected(issues, 'GROUP_UPDATE');
    });

    it('uses the final value for duplicate Map keys', () => {
        const issues = validateWithGroupCollection(
            `new Map([
        [AppInboxType.GROUP_CREATE, AppInboxType.GROUP_UPDATE],
        [AppInboxType.GROUP_CREATE, AppInboxType.GROUP_CREATE],
      ]).values()`
        );
        expectConnected(issues, 'GROUP_CREATE');
        expectMissing(issues, 'GROUP_UPDATE');
    });

    it('retains a common key guarantee across conditional Map entries', () => {
        const issues = validateWithGroupCollection(
            `new Map(enabled
        ? [[AppInboxType.GROUP_CREATE, AppInboxType.GROUP_UPDATE]]
        : [[AppInboxType.GROUP_CREATE, AppInboxType.GROUP_CREATE]]).keys()`,
            'const enabled = true as boolean;'
        );
        expectConnected(issues, 'GROUP_CREATE');
        expectMissing(issues, 'GROUP_UPDATE');
    });

    it('does not establish ownership from an unknown Map shape', () => {
        const issues = validateWithGroupCollection(
            'new Map(unknownEntries()).keys()',
            'function unknownEntries(): readonly (readonly [AppInboxType, AppInboxType])[] { return []; }'
        );
        expectMissing(issues, 'GROUP_CREATE');
        expectMissing(issues, 'GROUP_UPDATE');
    });

    it('does not merge an unprojected Map key and value into scalar ownership', () => {
        const issues = validateWithGroupCollection(
            'new Map([[AppInboxType.GROUP_CREATE, AppInboxType.GROUP_UPDATE]])'
        );
        expectMissing(issues, 'GROUP_CREATE');
        expectMissing(issues, 'GROUP_UPDATE');
    });
});

function expectMutation(name: string): void {
    const root = `${FIXTURES}/${name}`;
    expect(findMutationBoundaryViolationsFromRoots([root]), root).toEqual([
        expect.objectContaining({
            filePath: root,
            directMutatorCalls: ['ClientStateRepository.insertPrincipal']
        })
    ]);
}

function validateWithGroupCollection(collection: string, appendedSource = ''): readonly string[] {
    const source = GROUP_OWNER_SOURCE;
    const mutated = source.replace(LIVE_GROUP_COLLECTION, collection) + `\n${appendedSource}\n`;
    expect(mutated).not.toBe(source);
    return validateMutationRouteInventory(MUTATION_ROUTE_INVENTORY, {
        sourceOverrides: new Map([[GROUP_OWNER, mutated]])
    });
}

function expectMissing(issues: readonly string[], type: string): void {
    expect(issues).toEqual(
        expect.arrayContaining([expect.stringContaining(`${type} owner dispatch is not connected`)])
    );
}

function expectConnected(issues: readonly string[], type: string): void {
    expect(issues).not.toEqual(
        expect.arrayContaining([expect.stringContaining(`${type} owner dispatch is not connected`)])
    );
}
