import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import { findMutationBoundaryViolationsFromRoots } from './mutation-boundary-analysis.ts';
import { MUTATION_ROUTE_INVENTORY, validateMutationRouteInventory } from './mutation-routing-inventory.ts';

const FIXTURES = 'packages/tests/shared-server/fixtures/mutation-boundary-capability-receivers';
const GROUP_OWNER = 'packages/shared-server/rallar-system/group-state/inbox/group-state-inbox-service.ts';
const GROUP_TYPES = 'packages/shared-server/rallar-system/group-state/inbox/group-state-inbox-contracts.ts';
const TOPOLOGY_OWNER = 'packages/shared-server/rallar-system/topology/inbox/topology-inbox-service.ts';
const AUTH_OWNER = 'packages/shared-server/rallar-system/auth/inbox/app-auth-inbox-service.ts';
const CRDT_OWNER = 'packages/shared-server/rallar-system/crdt/inbox/app-crdt-inbox-service.ts';
const CRDT_TYPES = 'packages/shared-server/rallar-system/crdt/mutation/crdt-mutation-contracts.ts';
const CLIENT_OWNER = 'packages/shared-server/rallar-system/client-state/inbox/app-client-inbox-service.ts';

describe('Mutation route owner registration collections contracts', () => {
    it.each([
        'local-alias.ts',
        'imported-object-alias.ts',
        'object-parameter.ts',
        'assertions.ts',
        'destructured-method.ts',
        'nested-destructured.ts',
        'nested-renamed-capture.ts'
    ])('resolves mutable capability provenance in %s', (name) => {
        const root = `${FIXTURES}/${name}`;
        expect(findMutationBoundaryViolationsFromRoots([root]), root).toEqual([
            expect.objectContaining({
                filePath: root,
                directMutatorCalls: ['ClientStateRepository.insertPrincipal']
            })
        ]);
    });

    it('retains read-only provenance without flagging ordinary domain objects', () => {
        expect(
            findMutationBoundaryViolationsFromRoots([
                `${FIXTURES}/read-only-object.ts`,
                `${FIXTURES}/ordinary-domain-object.ts`
            ])
        ).toEqual([]);
    });

    it('rejects GROUP_CREATE removed from the imported live group registration collection', () => {
        const source = readFileSync(GROUP_TYPES, 'utf8');
        const mutated = source.replace('  AppInboxType.GROUP_CREATE,\n', '');
        expect(mutated).not.toBe(source);

        expect(validateWithOverrides(new Map([[GROUP_TYPES, mutated]]))).toEqual(
            expect.arrayContaining([
                expect.stringContaining('GROUP_CREATE owner dispatch is not connected')
            ])
        );
    });

    it('rejects an auth registration loop replaced with an empty iterable', () => {
        const source = readFileSync(AUTH_OWNER, 'utf8');
        const mutated = source.replace('for (const type of AUTH_TYPES)', 'for (const type of [])');
        expect(mutated).not.toBe(source);

        expect(validateWithOverrides(new Map([[AUTH_OWNER, mutated]]))).toEqual(
            expect.arrayContaining([
                expect.stringContaining('AUTH_USER_REGISTER owner dispatch is not connected')
            ])
        );
    });

    it('rejects a CRDT type removed from its imported live registration collection', () => {
        const source = readFileSync(CRDT_TYPES, 'utf8');
        const mutated = source.replace('  AppInboxType.CRDT_UPDATE_APPEND,\n', '');
        expect(mutated).not.toBe(source);

        expect(
            validateWithOverrides(
                new Map([
                    [CRDT_OWNER, readFileSync(CRDT_OWNER, 'utf8')],
                    [CRDT_TYPES, mutated]
                ])
            )
        ).toEqual(
            expect.arrayContaining([
                expect.stringContaining('CRDT_UPDATE_APPEND owner dispatch is not connected')
            ])
        );
    });

    it('binds topology registrations to the topology owner types', () => {
        const topology = readFileSync(TOPOLOGY_OWNER, 'utf8');
        const withoutTopology = topology.replace('    AppInboxType.TOPOLOGY_CONFIG_PUT,\n', '');
        expect(withoutTopology).not.toBe(topology);

        expect(validateWithOverrides(new Map([[TOPOLOGY_OWNER, withoutTopology]]))).toEqual(
            expect.arrayContaining([
                expect.stringContaining('TOPOLOGY_CONFIG_PUT owner dispatch is not connected')
            ])
        );
    });

    it('binds direct client registrations to their live types', () => {
        const client = readFileSync(CLIENT_OWNER, 'utf8');
        const wrongClient = client.replace(
            'AppInboxType.CLIENT_PRINCIPAL_UPSERT,',
            'AppInboxType.CLIENT_INSTANCE_UPSERT,'
        ) + '\nfunction deadClientType(): void { void AppInboxType.CLIENT_PRINCIPAL_UPSERT; }\n';

        expect(validateWithOverrides(new Map([[CLIENT_OWNER, wrongClient]]))).toEqual(
            expect.arrayContaining([
                expect.stringContaining('CLIENT_PRINCIPAL_UPSERT owner dispatch is not connected')
            ])
        );
    });
});

function validateWithOverrides(overrides: ReadonlyMap<string, string>): readonly string[] {
    return validateMutationRouteInventory(MUTATION_ROUTE_INVENTORY, {
        sourceOverrides: overrides
    });
}
