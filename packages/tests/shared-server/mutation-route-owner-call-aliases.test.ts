import { describe, expect, it } from 'vitest';

import { findMutationBoundaryViolationsFromRoots } from './mutation-boundary-analysis.ts';
import { readGroupOwnerAnchors } from './mutation-route-owner-anchors.ts';
import { MUTATION_ROUTE_INVENTORY, validateMutationRouteInventory } from './mutation-routing-inventory.ts';

const FIXTURES = 'packages/tests/shared-server/fixtures/mutation-boundary-capability-receivers';
const GROUP_OWNER = 'packages/shared-server/rallar-system/group-state/inbox/group-state-inbox-service.ts';
const {
    source: GROUP_OWNER_SOURCE,
    collection: LIVE_GROUP_COLLECTION,
    loopStart: LOOP_START,
    loopEnd: LOOP_END,
    classStart: CLASS_START
} = readGroupOwnerAnchors();
const TYPE_MAP = `const C12_TYPE_MAP = new Map([
    [AppInboxType.GROUP_CREATE, AppInboxType.GROUP_UPDATE],
]);`;
const TYPE_OBJECT = `{
            [AppInboxType.GROUP_CREATE]: AppInboxType.GROUP_UPDATE,
        }`;

describe('Mutation route owner call aliases contracts', () => {
    it.each([8, 9, 12, 30])('converges capability setter and factory chains at depth %i', (depth) => {
        expectMutation(`c12-depth-${depth}.ts`, [
            'ClientStateRepository.insertPrincipal',
            'ClientStateRepository.updatePrincipal'
        ]);
    });

    it.each(['c12-control-cycle.ts', 'c12-control-factory-bind.ts'])(
        'terminates cleanly for a capability cycle or unused factory in %s',
        (name) => {
            expectClean(name);
        }
    );

    it('resolves a namespace factory through member, computed, bind, and call aliases', () => {
        expectMutation('c12-namespace-alias.ts', ['ClientStateRepository.insertPrincipal']);
    });

    it('normalizes factory call, apply, and later-invoked bind shapes', () => {
        expectMutation('c12-factory-call-family.ts', [
            'ClientStateRepository.deletePrincipal',
            'ClientStateRepository.insertPrincipal',
            'ClientStateRepository.updatePrincipal'
        ]);
    });

    it('fails closed for a reachable unresolved local factory alternative', () => {
        expectMutation('c12-factory-unknown-branch.ts', ['ClientStateRepository.insertPrincipal']);
    });

    it.each([
        'c12-call-arguments.ts',
        'c12-bound-alias-chain.ts',
        'c12-apply-unknown.ts',
        'c12-post-store-destructure.ts',
        'c12-sparse-array.ts',
        'c12-array-flow-pattern.ts',
        'c12-default-rest.ts',
        'c12-factory-array.ts'
    ])('applies normalized invocation and storage effects in %s', (name) => {
        expectMutation(name, ['ClientStateRepository.insertPrincipal']);
    });

    it('preserves shared array and object heap mutations through aliases', () => {
        expectMutation('c12-heap-aliases.ts', [
            'ClientStateRepository.insertPrincipal',
            'ClientStateRepository.updatePrincipal'
        ]);
    });

    it('does not execute a bound callable until the bound value is called', () => {
        expectClean('c12-control-bound-never-called.ts');
    });

    it('uses an explicit invocation argument instead of the parameter default', () => {
        const issues = validateInvokedProjection(`registerC12('values');`);
        expectProjection(issues, 'GROUP_UPDATE', 'GROUP_CREATE');
    });

    it('uses the parameter default when the invocation omits the argument', () => {
        const issues = validateInvokedProjection(`registerC12();`);
        expectProjection(issues, 'GROUP_CREATE', 'GROUP_UPDATE');
    });

    it('uses the parameter default for an explicit undefined argument', () => {
        const issues = validateInvokedProjection(`registerC12(undefined);`);
        expectProjection(issues, 'GROUP_CREATE', 'GROUP_UPDATE');
    });

    it('propagates invocation arguments through a local callable alias', () => {
        const issues = validateInvokedProjection(
            `const alias = registerC12;\n        alias('values');`
        );
        expectProjection(issues, 'GROUP_UPDATE', 'GROUP_CREATE');
    });

    it('combines registrations from multiple concrete invocations', () => {
        const issues = validateInvokedProjection(
            `registerC12('keys');\n        registerC12('values');`
        );
        expectConnected(issues, 'GROUP_CREATE');
        expectConnected(issues, 'GROUP_UPDATE');
    });

    it('keeps a conditional invocation argument unknown', () => {
        const issues = validateInvokedProjection(
            `registerC12(c12Enabled ? 'keys' : 'values');`,
            `declare const c12Enabled: boolean;`
        );
        expectMissing(issues, 'GROUP_CREATE');
        expectMissing(issues, 'GROUP_UPDATE');
    });

    it.each([
        [`const Object = { keys: (_value: unknown) => [] };`, ''],
        [`class Object { static keys(_value: unknown): unknown[] { return []; } }`, ''],
        [`let Object = globalThis.Object;\n        Object = { keys: (_value: unknown) => [] };`, '']
    ])('does not trust a local Object shadow: %s', (beforeLoop, topLevel) => {
        const issues = validateScopedMap(
            `Object.keys(${TYPE_OBJECT})`,
            topLevel,
            `        ${beforeLoop}\n`
        );
        expectMissing(issues, 'GROUP_CREATE');
        expectMissing(issues, 'GROUP_UPDATE');
    });

    it('does not trust an imported Object shadow', () => {
        const issues = validateScopedMap(
            `Object.keys(${TYPE_OBJECT})`,
            `import { Object } from './c12-shadow.ts';`,
            ''
        );
        expectMissing(issues, 'GROUP_CREATE');
        expectMissing(issues, 'GROUP_UPDATE');
    });

    it('does not trust an Object parameter shadow', () => {
        const issues = validateScopedMap(
            `Object.keys(${TYPE_OBJECT})`,
            '',
            `        function registerObject(Object: { keys(value: unknown): unknown[] }): void {\n`,
            `        }\n        registerObject({ keys: () => [] });\n`
        );
        expectMissing(issues, 'GROUP_CREATE');
        expectMissing(issues, 'GROUP_UPDATE');
    });

    it('does not trust a local Map constructor shadow', () => {
        const issues = validateScopedMap(
            `new Map([[AppInboxType.GROUP_CREATE, AppInboxType.GROUP_UPDATE]]).keys()`,
            '',
            `        const Map = class {\n            constructor(_entries: unknown) {}\n            keys(): unknown[] { return []; }\n        };\n`
        );
        expectMissing(issues, 'GROUP_CREATE');
        expectMissing(issues, 'GROUP_UPDATE');
    });

    it('resolves an alias of the proven global Object keys function', () => {
        const issues = validateScopedMap(
            `BuiltinObject.keys(${TYPE_OBJECT})`,
            '',
            `        const BuiltinObject = Object;\n`
        );
        expectProjection(issues, 'GROUP_CREATE', 'GROUP_UPDATE');
    });

    it('resolves globalThis.Object values', () => {
        const issues = validateScopedMap(`globalThis.Object.values(${TYPE_OBJECT})`, '', '');
        expectProjection(issues, 'GROUP_UPDATE', 'GROUP_CREATE');
    });

    it('resolves Object entries through a proven global alias and map projection', () => {
        const issues = validateScopedMap(
            `BuiltinObject.entries(${TYPE_OBJECT}).map(([key]) => key)`,
            '',
            `        const BuiltinObject = Object;\n`
        );
        expectProjection(issues, 'GROUP_CREATE', 'GROUP_UPDATE');
    });

    it('resolves new Map keys through a proven global alias', () => {
        const issues = validateScopedMap(
            `new BuiltinMap([[AppInboxType.GROUP_CREATE, AppInboxType.GROUP_UPDATE]]).keys()`,
            '',
            `        const BuiltinMap = Map;\n`
        );
        expectProjection(issues, 'GROUP_CREATE', 'GROUP_UPDATE');
    });

    it('resolves new globalThis.Map values', () => {
        const issues = validateScopedMap(
            `new globalThis.Map([[AppInboxType.GROUP_CREATE, AppInboxType.GROUP_UPDATE]]).values()`,
            '',
            ''
        );
        expectProjection(issues, 'GROUP_UPDATE', 'GROUP_CREATE');
    });

    it('keeps a conditional global/custom Object identity unknown', () => {
        const issues = validateScopedMap(
            `SelectedObject.keys(${TYPE_OBJECT})`,
            `declare const c12Enabled: boolean;`,
            `        const customObject = { keys: (_value: unknown) => [] };\n        const SelectedObject = c12Enabled ? Object : customObject;\n`
        );
        expectMissing(issues, 'GROUP_CREATE');
        expectMissing(issues, 'GROUP_UPDATE');
    });
});

function expectMutation(name: string, methods: readonly string[]): void {
    const root = `${FIXTURES}/${name}`;
    expect(findMutationBoundaryViolationsFromRoots([root]), root).toEqual([
        expect.objectContaining({
            filePath: root,
            directMutatorCalls: methods
        })
    ]);
}

function expectClean(name: string): void {
    expect(findMutationBoundaryViolationsFromRoots([`${FIXTURES}/${name}`])).toEqual([]);
}

function validateInvokedProjection(invocation: string, topLevel = ''): readonly string[] {
    return validateScopedMap(
        `C12_TYPE_MAP[MAP_METHOD]()`,
        `${TYPE_MAP}\n${topLevel}`,
        `        function registerC12(MAP_METHOD = 'keys'): void {\n`,
        `        }\n        ${invocation}\n`
    );
}

function validateScopedMap(
    collection: string,
    topLevel: string,
    beforeLoop: string,
    afterLoop = ''
): readonly string[] {
    const source = GROUP_OWNER_SOURCE;
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
