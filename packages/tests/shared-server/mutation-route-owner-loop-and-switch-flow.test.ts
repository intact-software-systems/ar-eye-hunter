import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import { findMutationBoundaryViolationsFromRoots } from './mutation-boundary-analysis.ts';
import { readGroupOwnerAnchors } from './mutation-route-owner-anchors.ts';
import { MUTATION_ROUTE_INVENTORY, validateMutationRouteInventory } from './mutation-routing-inventory.ts';

const FIXTURES = 'packages/tests/shared-server/fixtures/mutation-boundary-capability-receivers';
const GROUP_OWNER = 'packages/shared-server/rallar-system/group-state/inbox/group-state-inbox-service.ts';
const { collection: LIVE_GROUP_COLLECTION, loopStart: LOOP_START, loopEnd: LOOP_END, classStart: CLASS_START } = readGroupOwnerAnchors();
const TYPE_MAP = `const C14_TYPE_MAP = new Map([
    [AppInboxType.GROUP_CREATE, AppInboxType.GROUP_UPDATE],
]);`;

describe('Mutation route owner loop and switch flow contracts', () => {
    it('uses the heap alias state at a writer call before a later rebind', () => {
        expectMutation('c14-ordered-heap-writer-before-rebind.ts', [
            'ClientStateRepository.insertPrincipal'
        ]);
    });

    it('uses ordered rebinds for direct, nested, and destructured heap aliases', () => {
        expectMutation('c14-ordered-heap-rebinds.ts', [
            'ClientStateRepository.deletePrincipal',
            'ClientStateRepository.updatePrincipal'
        ]);
    });

    it('joins branch and loop heap states conservatively', () => {
        expectMutation('c14-ordered-heap-branches.ts', [
            'ClientStateRepository.insertPrincipal',
            'ClientStateRepository.updatePrincipal'
        ]);
    });

    it('snapshots a captured outer heap alias at its invocation', () => {
        expectMutation('c14-ordered-heap-captured.ts', [
            'ClientStateRepository.deletePrincipal',
            'ClientStateRepository.insertPrincipal'
        ]);
    });

    it('does not let a later writer rebind rewrite an earlier read-only call', () => {
        expectClean('c14-ordered-heap-controls.ts');
    });

    it('retains known capability factories across partially unknown computed keys', () => {
        expectMutation('c14-partial-computed-factory.ts', [
            'ClientStateRepository.deletePrincipal',
            'ClientStateRepository.insertPrincipal',
            'ClientStateRepository.updatePrincipal'
        ]);
    });

    it('keeps partially known keys on unrelated namespaces clean', () => {
        expectClean('c14-partial-computed-control.ts');
    });

    it('executes boundary switch cases through reachable fallthrough', () => {
        expectMutation('c14-switch-fallthrough.ts', [
            'ClientStateRepository.deletePrincipal',
            'ClientStateRepository.insertPrincipal',
            'ClientStateRepository.updatePrincipal'
        ]);
    });

    it('stops boundary switch fallthrough on break, return, and throw', () => {
        expectClean('c14-switch-controls.ts');
    });

    it('unions registrations from a matched case and its fallthrough case', () => {
        const issues = validateInvocations(`switch ('create') {
            case 'create':
                registerC14(undefined, 'keys');
            case 'update':
                registerC14(undefined, 'values');
                break;
        }`);
        expectBothProjections(issues);
    });

    it('skips a default before an exact later match', () => {
        const issues = validateInvocations(`switch ('update') {
            default:
                registerC14(undefined, 'keys');
                break;
            case 'update':
                registerC14(undefined, 'values');
                break;
        }`);
        expectProjection(issues, 'GROUP_UPDATE', 'GROUP_CREATE');
    });

    it('falls through from an exact match into a later default', () => {
        const issues = validateInvocations(`switch ('create') {
            case 'create':
                registerC14(undefined, 'keys');
            default:
                registerC14(undefined, 'values');
                break;
        }`);
        expectBothProjections(issues);
    });

    it('starts at default when no case matches', () => {
        const issues = validateInvocations(`switch ('missing') {
            case 'create':
                registerC14(undefined, 'keys');
                break;
            default:
                registerC14(undefined, 'values');
        }`);
        expectProjection(issues, 'GROUP_UPDATE', 'GROUP_CREATE');
    });

    it('continues through multiple cases until break', () => {
        const issues = validateInvocations(`switch ('create') {
            case 'create':
                registerC14(undefined, 'keys');
            case 'middle':
                void 0;
            case 'update':
                registerC14(undefined, 'values');
                break;
        }`);
        expectBothProjections(issues);
    });

    it('stops exact routing fallthrough at break', () => {
        const issues = validateInvocations(`switch ('create') {
            case 'create':
                registerC14(undefined, 'keys');
                break;
            case 'update':
                registerC14(undefined, 'values');
        }`);
        expectProjection(issues, 'GROUP_CREATE', 'GROUP_UPDATE');
    });

    it('intersects registrations across unknown fallthrough alternatives', () => {
        const issues = validateInvocations(
            `switch (c14Mode) {
            case 'create':
                registerC14(undefined, 'keys');
            case 'update':
                registerC14(undefined, 'values');
                break;
            default:
                registerC14(undefined, 'values');
        }`,
            `declare const c14Mode: string;`
        );
        expectProjection(issues, 'GROUP_UPDATE', 'GROUP_CREATE');
    });
});

function expectMutation(name: string, methods: readonly string[]): void {
    const root = `${FIXTURES}/${name}`;
    expect(findMutationBoundaryViolationsFromRoots([root]), root).toEqual([
        expect.objectContaining({ filePath: root, directMutatorCalls: methods })
    ]);
}

function expectClean(name: string): void {
    expect(findMutationBoundaryViolationsFromRoots([`${FIXTURES}/${name}`])).toEqual([]);
}

function validateInvocations(invocation: string, topLevel = ''): readonly string[] {
    const source = readFileSync(GROUP_OWNER, 'utf8');
    let mutated = source.replace(CLASS_START, `${TYPE_MAP}\n${topLevel}\n\n${CLASS_START}`);
    mutated = mutated.replace(
        LOOP_START,
        `        function registerC14(
            _ignored: unknown = undefined,
            MAP_METHOD = 'keys',
        ): void {\n${LOOP_START}`
    );
    mutated = mutated.replace(LOOP_END, `        }\n        ${invocation}\n${LOOP_END}`);
    mutated = mutated.replace(LIVE_GROUP_COLLECTION, 'C14_TYPE_MAP[MAP_METHOD]()');
    expect(mutated).not.toBe(source);
    return validateMutationRouteInventory(MUTATION_ROUTE_INVENTORY, {
        sourceOverrides: new Map([[GROUP_OWNER, mutated]])
    });
}

function expectBothProjections(issues: readonly string[]): void {
    expectConnected(issues, 'GROUP_CREATE');
    expectConnected(issues, 'GROUP_UPDATE');
}

function expectProjection(issues: readonly string[], connected: string, missing: string): void {
    expectConnected(issues, connected);
    expectMissing(issues, missing);
}

function hasMissingIssue(issues: readonly string[], type: string): boolean {
    return issues.some((issue) => issue.includes(`${type} owner dispatch is not connected`));
}

function expectMissing(issues: readonly string[], type: string): void {
    expect(hasMissingIssue(issues, type)).toBe(true);
}

function expectConnected(issues: readonly string[], type: string): void {
    expect(hasMissingIssue(issues, type)).toBe(false);
}
