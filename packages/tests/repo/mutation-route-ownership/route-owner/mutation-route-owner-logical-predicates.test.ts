import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import { findMutationBoundaryViolationsFromRoots } from '../boundary/mutation-boundary-analysis.ts';
import { MUTATION_ROUTE_INVENTORY, validateMutationRouteInventory } from '../routing/mutation-routing-inventory.ts';

const FIXTURES = 'packages/tests/repo/mutation-route-ownership/fixtures/mutation-boundary-capability-receivers';
const AUTH_OWNER = 'packages/shared-server/rallar-system/auth/inbox/app-auth-inbox-service.ts';
const PRODUCTION_COLLECTION = 'AUTH_TYPES';

describe('Mutation route owner logical predicates contracts', () => {
    it.each([
        'flow-sequence.ts',
        'flow-object-member.ts',
        'flow-object-closure.ts',
        'flow-conditional.ts',
        'flow-callback-capture.ts'
    ])('evaluates mutable method provenance at each call in %s', (name) => {
        const root = `${FIXTURES}/${name}`;
        expect(findMutationBoundaryViolationsFromRoots([root]), root).toEqual([
            expect.objectContaining({
                filePath: root,
                directMutatorCalls: ['ClientStateRepository.insertPrincipal']
            })
        ]);
    });

    it('keeps a proven read-only overwrite clean when it precedes the only call', () => {
        expect(
            findMutationBoundaryViolationsFromRoots([
                `${FIXTURES}/flow-benign-overwrite.ts`
            ])
        ).toEqual([]);
    });

    it('fails closed when negated includes reads an unknown function collection', () => {
        const issues = validateWithAuthFilter(
            '(candidate) => !disabledTypes().includes(candidate)',
            'function disabledTypes(): readonly AppInboxType[] { return []; }'
        );
        expect(issues).toEqual(
            expect.arrayContaining([
                expect.stringContaining('AUTH_USER_REGISTER owner dispatch is not connected')
            ])
        );
    });

    it('proves negated includes over a known empty collection', () => {
        expect(validateWithAuthFilter('(candidate) => ![].includes(candidate)'))
            .toEqual([]);
    });

    it('narrows negated includes over a known nonempty collection exactly', () => {
        const issues = validateWithAuthFilter(
            '(candidate) => ![AppInboxType.AUTH_USER_REGISTER].includes(candidate)'
        );
        expect(issues).toEqual(
            expect.arrayContaining([
                expect.stringContaining('AUTH_USER_REGISTER owner dispatch is not connected')
            ])
        );
        expect(issues).not.toEqual(
            expect.arrayContaining([
                expect.stringContaining('AUTH_SESSION_ISSUE owner dispatch is not connected')
            ])
        );
    });

    it('propagates unknown through logical predicates without losing proven true branches', () => {
        const issues = validateWithAuthFilter(
            '(candidate) => candidate === AppInboxType.AUTH_USER_REGISTER || !disabledTypes().includes(candidate)',
            'function disabledTypes(): readonly AppInboxType[] { return []; }'
        );
        expect(issues).toEqual(
            expect.arrayContaining([
                expect.stringContaining('AUTH_SESSION_ISSUE owner dispatch is not connected')
            ])
        );
        expect(issues).not.toEqual(
            expect.arrayContaining([
                expect.stringContaining('AUTH_USER_REGISTER owner dispatch is not connected')
            ])
        );
    });

    it.each([
        'AUTH_TYPES.filter(isEnabled)',
        'AUTH_TYPES.map(normalizeType)'
    ])(
        'keeps an unknown %s chain unknown under negated includes',
        (collection) => {
            const issues = validateWithAuthFilter(
                `(candidate) => !${collection}.includes(candidate)`,
                [
                    'function isEnabled(_type: AppInboxType): boolean { return true; }',
                    'function normalizeType(type: AppInboxType): AppInboxType { return type; }'
                ].join('\n')
            );
            expect(issues).toEqual(
                expect.arrayContaining([
                    expect.stringContaining(
                        'AUTH_USER_REGISTER owner dispatch is not connected'
                    )
                ])
            );
        }
    );
});

function validateWithAuthFilter(
    filter: string,
    appendedSource = ''
): readonly string[] {
    const source = readFileSync(AUTH_OWNER, 'utf8');
    expect(source, AUTH_OWNER).toContain(PRODUCTION_COLLECTION);
    const mutated = source.replace(
        `for (const type of ${PRODUCTION_COLLECTION})`,
        `for (const type of ${PRODUCTION_COLLECTION}.filter(${filter}))`
    ) +
        `\n${appendedSource}\n`;
    return validateMutationRouteInventory(MUTATION_ROUTE_INVENTORY, {
        sourceOverrides: new Map([[AUTH_OWNER, mutated]])
    });
}
