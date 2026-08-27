import { parse } from '@babel/parser';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { EXPECTED_MUTATION_ENTRYPOINT_COUNT, EXPECTED_MUTATION_TYPE_COUNT } from '../routing/mutation-routing-inventory.ts';

import * as boundaryAnalysis from '../boundary/mutation-boundary-analysis.ts';
import * as routingContract from '../routing/mutation-routing-inventory.ts';

const AUTHORISED_WS_HELPER = 'packages/shared-server/rallar-system/client-state/inbox/authorised-ws-client-app-inbox.ts';
const CRDT_ADMIN_MUTATIONS = 'apps/api-v1/src/crdt/create-crdt-admin-mutations.ts';

describe('Mutation route owner analysis contracts', () => {
    it('uses one named readonly input object for each authorised websocket enqueue helper', () => {
        const program = parse(read(AUTHORISED_WS_HELPER), {
            sourceType: 'module',
            plugins: ['typescript']
        }).program;
        const helpers = program.body
            .filter(
                (statement) =>
                    statement.type === 'ExportNamedDeclaration' &&
                    statement.declaration?.type === 'FunctionDeclaration' &&
                    statement.declaration.id?.name.startsWith('toAuthorisedWsClient')
            )
            .map((statement) => {
                if (
                    statement.type !== 'ExportNamedDeclaration' ||
                    statement.declaration?.type !== 'FunctionDeclaration'
                ) {
                    throw new Error('Unexpected helper declaration');
                }
                return statement.declaration;
            });

        expect(helpers.map((helper) => [helper.id?.name, helper.params.length])).toEqual([
            ['toAuthorisedWsClientConnectEnqueue', 1],
            ['toAuthorisedWsClientDisconnectEnqueue', 1],
            ['toAuthorisedWsClientScope', 1],
            ['toAuthorisedWsClientConnection', 1]
        ]);
        expect(read(AUTHORISED_WS_HELPER)).toContain(
            'interface ToAuthorisedWsClientConnectEnqueueInput'
        );
        expect(read(AUTHORISED_WS_HELPER)).toContain(
            'interface ToAuthorisedWsClientDisconnectEnqueueInput'
        );
    });

    it('exports a syntax-aware analyzer for named, default, namespace, dynamic, and alias evasions', () => {
        const analyze = boundaryAnalysis.analyzeMutationBoundarySource;

        expect(analyze).toBeTypeOf('function');

        const evasions = [
            'import { GroupStateRepository as SafeName } from \'./repository.ts\';\nSafeName.prototype[\'createGroup\']({});',
            'import DefaultRepository from \'./repository.ts\';\nDefaultRepository.prototype.updateGroup({});',
            'import * as persistence from \'./repository.ts\';\npersistence.GroupStateRepository.prototype.joinGroup({});',
            'const { reconfigureGroupTopology: looksReadOnly } = service;\nlooksReadOnly({});',
            'const mutation = service[\'writeSnapshot\'];\nmutation({});',
            'await import(\'./repository.ts\').then(({ GroupStateRepository: R }) => R.prototype.createGroup({}));',
            'const AppTotallyNotInbox = repository;\nAppTotallyNotInbox.createGroup({});'
        ];

        for (const [index, source] of evasions.entries()) {
            const violation = analyze(source, `evasion-${index}.ts`);
            expect(
                violation.directMutatorCalls.length + violation.mutatingImports.length,
                source
            ).toBeGreaterThan(0);
        }
    });

    it('maps every entrypoint and type to real registrations and owners', () => {
        const inventory = routingContract.MUTATION_ROUTE_INVENTORY;
        const validate = routingContract.validateMutationRouteInventory;

        expect(inventory).toHaveLength(EXPECTED_MUTATION_ENTRYPOINT_COUNT);
        expect(new Set(inventory.map((entry) => entry.type)).size).toBe(EXPECTED_MUTATION_TYPE_COUNT);
        expect(validate(inventory)).toEqual([]);
    });

    it('rejects a CRDT reservation builder disconnected from command materialization', () => {
        const source = read(CRDT_ADMIN_MUTATIONS);
        const connectedMaterializer = 'materialize: () => createCrdtAdminCommand(input.mutation),';
        const disconnected = source.replace(
            connectedMaterializer,
            'materialize: () => disconnectedCrdtAdminCommand(input.mutation),'
        );
        expect(disconnected).not.toBe(source);
        const issues = routingContract.validateMutationRouteInventory(
            routingContract.MUTATION_ROUTE_INVENTORY,
            { sourceOverrides: new Map([[CRDT_ADMIN_MUTATIONS, disconnected]]) }
        );

        expect(issues).toEqual(
            expect.arrayContaining([
                expect.stringContaining(
                    'CRDT_PROJECTION_REBUILD operation is not connected to ' +
                        'writeHttpAdminCommandUntilCompletion'
                )
            ])
        );
    });

    it('keeps every strict HTTP mutation in the reachability audit', () => {
        const auditedEntrypoints = new Set(
            routingContract.MUTATION_ROUTE_INVENTORY.map((entry) => `${entry.entrypoint}:${entry.type}`)
        );

        expect(auditedEntrypoints.size).toBe(EXPECTED_MUTATION_ENTRYPOINT_COUNT);
        for (const entrypoint of STRICT_TASK_FOUR_MUTATION_ENTRYPOINTS) {
            expect(auditedEntrypoints, entrypoint).toContain(entrypoint);
        }
    });

    it.each([
        STRICT_TASK_FOUR_MUTATION_ENTRYPOINTS[0],
        STRICT_TASK_FOUR_MUTATION_ENTRYPOINTS[5],
        STRICT_TASK_FOUR_MUTATION_ENTRYPOINTS[6],
        STRICT_TASK_FOUR_MUTATION_ENTRYPOINTS[10]
    ])('fails closed when the strict handoff changes for %s', (entrypoint) => {
        const inventory = routingContract.MUTATION_ROUTE_INVENTORY;
        const target = inventory.find((entry) => `${entry.entrypoint}:${entry.type}` === entrypoint);
        if (!target) {
            throw new Error(`Strict mutation inventory entry is missing: ${entrypoint}`);
        }
        const mutated = inventory.map((entry) => entry === target ? { ...entry, enqueueMarker: 'bypassStrictAppInboxReservation' } : entry);

        expect(routingContract.validateMutationRouteInventory(mutated)).toEqual(
            expect.arrayContaining([
                expect.stringContaining(`${target.transport}:${target.entrypoint}:${target.type}`),
                expect.stringContaining('incorrect enqueueMarker')
            ])
        );
    });

    it('rejects representative route, type, owner, and path inventory mutations', () => {
        const inventory = routingContract.MUTATION_ROUTE_INVENTORY;
        const validate = routingContract.validateMutationRouteInventory;
        const first = inventory[0];
        if (!first) {
            throw new Error('Mutation route inventory is empty');
        }

        for (
            const mutation of [
                { ...first, entrypoint: `${first.entrypoint}-wrong` },
                { ...first, type: inventory[1]?.type ?? first.type },
                { ...first, owner: 'ArbitraryOwner.processCommand' },
                { ...first, sourcePath: 'apps/api-v1/src/routes/not-a-route.ts' }
            ]
        ) {
            expect(validate([mutation])).not.toEqual([]);
        }
    });
});

function read(filePath: string): string {
    return readFileSync(filePath, 'utf8');
}

const STRICT_TOPOLOGY_PATH = '/api/state/apps/:applicationId/workspaces/:workspaceId/groups/:groupId/topology';

const STRICT_TASK_FOUR_MUTATION_ENTRYPOINTS = [
    `PUT ${STRICT_TOPOLOGY_PATH}/config/requests/:requestId:TOPOLOGY_CONFIG_PUT`,
    `DELETE ${STRICT_TOPOLOGY_PATH}/config/requests/:requestId:TOPOLOGY_CONFIG_DELETE`,
    `PUT ${STRICT_TOPOLOGY_PATH}/override/requests/:requestId:TOPOLOGY_OVERRIDE_PUT`,
    `DELETE ${STRICT_TOPOLOGY_PATH}/override/requests/:requestId:TOPOLOGY_OVERRIDE_DELETE`,
    `POST ${STRICT_TOPOLOGY_PATH}/reconfigure/requests/:requestId:TOPOLOGY_RECONFIGURE`,
    'POST /api/admin/operations/topology/recompute/requests/:requestId:TOPOLOGY_RECONFIGURE',
    'POST /api/admin/operations/maintenance/prune-expired/requests/:requestId:ADMIN_PRUNE_EXPIRED',
    'POST /api/admin/operations/crdt/compact/requests/:requestId:CRDT_SNAPSHOT_COMPACT',
    'POST /api/admin/operations/crdt/lifecycle/requests/:requestId:CRDT_LIFECYCLE_UPDATE',
    'POST /api/admin/operations/crdt/erase/requests/:requestId:CRDT_ERASE',
    'POST /api/crdt/admin/documents/rebuild-projection/requests/:requestId:CRDT_PROJECTION_REBUILD',
    'POST /api/crdt/admin/documents/compact/requests/:requestId:CRDT_SNAPSHOT_COMPACT',
    'POST /api/crdt/admin/documents/lifecycle/requests/:requestId:CRDT_LIFECYCLE_UPDATE',
    'POST /api/crdt/admin/documents/erase/requests/:requestId:CRDT_ERASE'
] as const;
