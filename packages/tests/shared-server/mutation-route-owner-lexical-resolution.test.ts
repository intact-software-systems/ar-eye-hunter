import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import { findMutationBoundaryViolationsFromRoots } from './mutation-boundary-analysis.ts';
import { readGroupOwnerAnchors } from './mutation-route-owner-anchors.ts';
import { MUTATION_ROUTE_INVENTORY, validateMutationRouteInventory } from './mutation-routing-inventory.ts';

const FIXTURES = 'packages/tests/shared-server/fixtures/mutation-boundary-capability-receivers';
const GROUP_OWNER = 'packages/shared-server/rallar-system/group-state/inbox/group-state-inbox-service.ts';
const { collection: LIVE_GROUP_COLLECTION, loopStart: LOOP_START, loopEnd: LOOP_END, classStart: CLASS_START } = readGroupOwnerAnchors();
const TYPE_MAP = `const C11_TYPE_MAP = new Map([
    [AppInboxType.GROUP_CREATE, AppInboxType.GROUP_UPDATE],
]);`;

describe('Mutation route owner lexical resolution contracts', () => {
    it.each([
        'c11-factory-local-alias.ts',
        'c11-factory-import-alias.ts',
        'c11-factory-namespace.ts',
        'c11-factory-conditional-member.ts',
        'c11-factory-returned.ts'
    ])('resolves lexically scoped repository factories in %s', (name) => {
        expectMutation(name);
    });

    it.each(['c11-control-shadowed-factory.ts', 'c11-control-shadowed-namespace.ts'])(
        'does not inherit capability provenance through a shadow in %s',
        (name) => {
            expect(findMutationBoundaryViolationsFromRoots([`${FIXTURES}/${name}`])).toEqual([]);
        }
    );

    it.each([
        'c11-concise-return.ts',
        'c11-concise-object.ts',
        'c11-call-family.ts',
        'c11-array-storage.ts',
        'c11-outer-array-storage.ts',
        'c11-destructured-storage.ts',
        'c11-conditional-storage.ts',
        'c11-outer-overwrite-write.ts'
    ])('applies reachable callable storage effects in %s', (name) => {
        expectMutation(name);
    });

    it.each([
        'c11-control-stored-never-called.ts',
        'c11-control-returned-never-called.ts',
        'c11-control-overwrite-read.ts',
        'c11-control-large-recursive.ts'
    ])('keeps unreachable or overwritten callable storage clean in %s', (name) => {
        expect(findMutationBoundaryViolationsFromRoots([`${FIXTURES}/${name}`])).toEqual([]);
    });

    it('uses a local keys shadow instead of a top-level values binding', () => {
        const issues = validateScopedMap(
            `C11_TYPE_MAP[MAP_METHOD]()`,
            `${TYPE_MAP}\nconst MAP_METHOD = 'values';`,
            `        const MAP_METHOD = 'keys';\n`
        );
        expectProjection(issues, 'GROUP_CREATE', 'GROUP_UPDATE');
    });

    it('uses a local values shadow instead of a top-level keys binding', () => {
        const issues = validateScopedMap(
            `C11_TYPE_MAP[MAP_METHOD]()`,
            `${TYPE_MAP}\nconst MAP_METHOD = 'keys';`,
            `        const MAP_METHOD = 'values';\n`
        );
        expectProjection(issues, 'GROUP_UPDATE', 'GROUP_CREATE');
    });

    it('resolves a nested block shadow at the projection call', () => {
        const issues = validateScopedMap(
            `C11_TYPE_MAP[MAP_METHOD]()`,
            `${TYPE_MAP}\nconst MAP_METHOD = 'values';`,
            `        {\n            const MAP_METHOD = 'keys';\n`,
            `        }\n`
        );
        expectProjection(issues, 'GROUP_CREATE', 'GROUP_UPDATE');
    });

    it('resolves a nested function shadow at the projection call', () => {
        const issues = validateScopedMap(
            `C11_TYPE_MAP[MAP_METHOD]()`,
            `${TYPE_MAP}\nconst MAP_METHOD = 'values';`,
            `        function registerC11(): void {\n            const MAP_METHOD = 'keys';\n`,
            `        }\n        registerC11();\n`
        );
        expectProjection(issues, 'GROUP_CREATE', 'GROUP_UPDATE');
    });

    it('resolves a defaulted parameter shadow at the projection call', () => {
        const issues = validateScopedMap(
            `C11_TYPE_MAP[MAP_METHOD]()`,
            `${TYPE_MAP}\nconst MAP_METHOD = 'values';`,
            `        function registerC11(MAP_METHOD = 'keys'): void {\n`,
            `        }\n        registerC11();\n`
        );
        expectProjection(issues, 'GROUP_CREATE', 'GROUP_UPDATE');
    });

    it('uses the last unconditional method assignment before the call', () => {
        const issues = validateScopedMap(
            `C11_TYPE_MAP[MAP_METHOD]()`,
            TYPE_MAP,
            `        let MAP_METHOD = 'values';\n        MAP_METHOD = 'keys';\n`
        );
        expectProjection(issues, 'GROUP_CREATE', 'GROUP_UPDATE');
    });

    it('does not use a method assignment after the call', () => {
        const issues = validateScopedMap(
            `C11_TYPE_MAP[MAP_METHOD]()`,
            TYPE_MAP,
            `        let MAP_METHOD = 'keys';\n`,
            `        MAP_METHOD = 'values';\n`
        );
        expectProjection(issues, 'GROUP_CREATE', 'GROUP_UPDATE');
    });

    it('keeps an ambiguous conditional method unknown', () => {
        const issues = validateScopedMap(
            `C11_TYPE_MAP[MAP_METHOD]()`,
            `${TYPE_MAP}\ndeclare const c11Enabled: boolean;`,
            `        const MAP_METHOD = c11Enabled ? 'keys' : 'values';\n`
        );
        expectMissing(issues, 'GROUP_CREATE');
        expectMissing(issues, 'GROUP_UPDATE');
    });

    it('preserves projection through a lexical alias composition', () => {
        const issues = validateScopedMap(
            `C11_TYPE_MAP[MAP_METHOD]()`,
            TYPE_MAP,
            `        const FIRST_METHOD = 'keys';\n        const MAP_METHOD = FIRST_METHOD;\n`
        );
        expectProjection(issues, 'GROUP_CREATE', 'GROUP_UPDATE');
    });

    it('uses the same lexical method rules for Object projections', () => {
        const issues = validateScopedMap(
            `Object[MAP_METHOD]({
            [AppInboxType.GROUP_CREATE]: AppInboxType.GROUP_UPDATE,
        })`,
            `const MAP_METHOD = 'values';`,
            `        const MAP_METHOD = 'keys';\n`
        );
        expectProjection(issues, 'GROUP_CREATE', 'GROUP_UPDATE');
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

function validateScopedMap(
    collection: string,
    topLevel: string,
    beforeLoop: string,
    afterLoop = ''
): readonly string[] {
    const source = readFileSync(GROUP_OWNER, 'utf8');
    let mutated = source.replace(CLASS_START, `${topLevel}\n\n${CLASS_START}`);
    mutated = mutated.replace(LOOP_START, `${beforeLoop}${LOOP_START}`);
    mutated = mutated.replace(LOOP_END, `${afterLoop}${LOOP_END}`);
    mutated = mutated.replace(LIVE_GROUP_COLLECTION, collection);
    expect(mutated).not.toBe(source);
    return validateMutationRouteInventory(MUTATION_ROUTE_INVENTORY, {
        sourceOverrides: new Map([[GROUP_OWNER, mutated]])
    });
}

function expectProjection(issues: readonly string[], connected: string, missing: string): void {
    expectConnected(issues, connected);
    expectMissing(issues, missing);
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
