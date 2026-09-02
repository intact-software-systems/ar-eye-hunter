import { PGlite } from '@electric-sql/pglite';
import { readFileSync } from 'node:fs';
// dprint-ignore
import {
    describe,
    expect,
    it
} from 'vitest';

import { resolveGroupTopologyConfig } from '@shared-server/rallar-system/topology/config/group-topology-config.ts';
import type {
    GroupTopologyReconfigureCommand,
    GroupTopologyReconfigureRead
} from '@shared-server/rallar-system/topology/reconfigure/group-topology-reconfigure-contracts.ts';
import {
    computeGroupTopologyReconfigureMutation,
    validateGroupTopologyReconfigureMutation,
    writeGroupTopologyReconfigureMutation
} from '@shared-server/rallar-system/topology/reconfigure/group-topology-reconfigure-mutation.ts';
import { RuntimeStateWriteConflictError } from '@shared-server/runtime-state/optimistic-runtime-state-write.ts';
import { PSqlRuntimeStateRepository } from '@shared-server/runtime-state/postgres/p-sql-runtime-state-repository.ts';

import { createPGliteSqlClient } from '../../../../../../apps/api-v1/src/db/pglite-sql-adapter.ts';
import {
    createTopologyTestAuthorityGuard,
    createTopologyTestGroupRef,
    createTopologyTestGroupSnapshot
} from '../config/mutation/group-topology-config-mutation-test-fixtures.ts';

describe('GroupTopologyReconfigureMutation', () => {
    it.each([-0, Number.MAX_SAFE_INTEGER])('rejects original authority revision %s before writing', (revision) => {
        const command = createCommand();
        const original = createRead();
        const read = {
            ...original,
            authorityGuard: { ...original.authorityGuard, entry: { ...original.authorityGuard.entry, revision } }
        };
        const computed = computeGroupTopologyReconfigureMutation(command, read);
        expect(computed.authorityWrite.expectedRevision).toBe(revision);
        expect(validateGroupTopologyReconfigureMutation(command, read, computed)).toEqual(expect.arrayContaining([
            expect.objectContaining({ path: 'read.authorityGuard.entry.revision', cause: expect.any(Error) })
        ]));
    });

    it('accepts the last incrementable authority revision', () => {
        const command = createCommand();
        const original = createRead();
        const read = {
            ...original,
            authorityGuard: {
                ...original.authorityGuard,
                entry: { ...original.authorityGuard.entry, revision: Number.MAX_SAFE_INTEGER - 1 }
            }
        };
        const computed = computeGroupTopologyReconfigureMutation(command, read);
        expect(validateGroupTopologyReconfigureMutation(command, read, computed)).toEqual([]);
        expect(computed.authorityWriteExpectedResultRevision).toBe(Number.MAX_SAFE_INTEGER);
    });

    it('computes the deterministic explicit outbox intent from the captured command', () => {
        const command = createCommand();
        const read = createRead();

        const computed = computeGroupTopologyReconfigureMutation(command, read);

        expect(computed).toMatchObject({
            commandId: 'reconfigure-request',
            resourceId: 'reconfigure-request:rtc-topology-recompute:explicit',
            aggregateRef: createTopologyTestGroupRef(),
            acceptedCausalRevision: { groupRevision: 1, presenceRevision: 0 },
            effectKind: 'rtc-topology-recompute',
            payloadKind: 'group-revision',
            createdAtEpochMs: 1_000,
            senderId: 'owner',
            requestOptions: {
                topologyKind: { action: 'preserve' },
                degreeLimit: { action: 'set', value: 7 },
                treeMinSize: { action: 'preserve' },
                meshMinSize: { action: 'preserve' },
                meshParamK: { action: 'preserve' }
            },
            publish: true
        });
        expect(computed.authorityWrite).toEqual({
            operation: 'update',
            namespace: 'group-state:groups',
            key: read.authorityGuard.entry.key,
            expectedRevision: read.authorityGuard.entry.revision,
            value: read.authorityGuard.entry.value,
            expireAtTimestamp: read.authorityGuard.entry.expireAtTimestamp
        });
        expect(validateGroupTopologyReconfigureMutation(command, read, computed)).toEqual([]);
    });

    it('rejects a non-admin actor who cannot update the current group', () => {
        const command = { ...createCommand(), actorPrincipalId: 'intruder' };
        const read = createRead();

        expect(validateGroupTopologyReconfigureMutation(command, read, computeGroupTopologyReconfigureMutation(command, read)))
            .toMatchObject([{ path: 'actor', message: 'Forbidden: An active group member is required for this operation.' }]);
    });

    it('uses the administrator decision captured by read', () => {
        const read = createRead();
        const command = { ...createCommand(), actorPrincipalId: 'intruder' };
        const callerDeniedCommand = { ...command, isPlatformAdmin: false };
        const callerAllowedCommand = { ...command, isPlatformAdmin: true };

        expect(
            validateGroupTopologyReconfigureMutation(
                callerDeniedCommand,
                { ...read, actorIsPlatformAdmin: true },
                computeGroupTopologyReconfigureMutation(callerDeniedCommand, read)
            )
        ).toEqual([]);
        expect(
            validateGroupTopologyReconfigureMutation(
                callerAllowedCommand,
                read,
                computeGroupTopologyReconfigureMutation(callerAllowedCommand, read)
            )
        ).toMatchObject([{ path: 'actor', message: 'Forbidden: An active group member is required for this operation.' }]);
    });

    it('rejects altered computation before the transaction boundary', () => {
        const command = createCommand();
        const read = createRead();
        const computed = { ...computeGroupTopologyReconfigureMutation(command, read), publish: false };

        expect(validateGroupTopologyReconfigureMutation(command, read, computed)).toMatchObject([
            { path: 'mutation.publish' }
        ]);
    });

    it('rejects an altered authority write before the transaction boundary', () => {
        const command = createCommand();
        const read = createRead();
        const computed = computeGroupTopologyReconfigureMutation(command, read);

        expect(validateGroupTopologyReconfigureMutation(command, read, {
            ...computed,
            authorityWrite: { ...computed.authorityWrite, key: 'attacker-selected' }
        })).toMatchObject([{ path: 'mutation.authorityWrite.key' }]);
    });

    it('returns issues instead of throwing for invalid original expiry facts', () => {
        const command = createCommand();
        const read = createRead();
        const computed = computeGroupTopologyReconfigureMutation(command, read);
        const invalidRead = {
            ...read,
            authorityGuard: {
                ...read.authorityGuard,
                entry: { ...read.authorityGuard.entry, expireAtTimestamp: NaN }
            }
        };

        expect(validateGroupTopologyReconfigureMutation(command, invalidRead, computed))
            .toMatchObject([{ path: 'mutation', cause: expect.any(Error) }]);
    });

    it.each(['causal revision', 'physical expiry', 'stored group JSON'] as const)(
        'rejects an invalid original authority guard %s even when the candidate matches it',
        (field) => {
            const command = createCommand();
            const original = createRead();
            const read = {
                ...original,
                authorityGuard: {
                    ...original.authorityGuard,
                    causalGroupRevision: field === 'causal revision' ? 999 : original.authorityGuard.causalGroupRevision,
                    entry: {
                        ...original.authorityGuard.entry,
                        expireAtTimestamp: field === 'physical expiry' ? 60_000 : original.authorityGuard.entry.expireAtTimestamp,
                        value: field === 'stored group JSON' ? '{}' : original.authorityGuard.entry.value
                    }
                }
            };
            const computed = computeGroupTopologyReconfigureMutation(command, read);

            expect(validateGroupTopologyReconfigureMutation(command, read, computed))
                .toMatchObject([{ path: 'mutation', cause: expect.any(Error) }]);
        }
    );

    it('rejects a stale authority revision in one attempt before any outbox write', async () => {
        const sql = createPGliteSqlClient(new PGlite());
        try {
            await sql.exec(readFileSync(
                new URL('../../../../../../apps/api-v1/src/db/in-memory-schema.sql', import.meta.url),
                'utf8'
            ));
            const command = createCommand();
            const read = createRead();
            const runtime = new PSqlRuntimeStateRepository(sql);
            const guard = read.authorityGuard.entry;
            await runtime.upsert('group-state:groups', guard.key, guard.value, guard.expireAtTimestamp);
            const computed = computeGroupTopologyReconfigureMutation(command, read);
            expect(validateGroupTopologyReconfigureMutation(command, read, computed)).toEqual([]);

            const refreshedGroup = JSON.stringify({ ...read.authority.group.group, displayName: 'Refreshed group' });
            await runtime.upsert('group-state:groups', guard.key, refreshedGroup, guard.expireAtTimestamp);
            const refreshedEntry = await runtime.findEntry('group-state:groups', guard.key);
            expect(refreshedEntry).toMatchObject({ revision: 1, value: refreshedGroup });

            await expect(sql.begin(async (transaction) => await writeGroupTopologyReconfigureMutation(transaction, computed)))
                .rejects.toBeInstanceOf(RuntimeStateWriteConflictError);

            expect(await runtime.findEntry('group-state:groups', guard.key)).toEqual(refreshedEntry);
            const rows = await sql<Array<{ count: number; }>>`
                select count(*)::int as count from resource_inbox where ri_type_id = 'APP_OUTBOX'
            `;
            expect(rows).toEqual([{ count: 0 }]);
        }
        finally {
            await sql.close();
        }
    });
});

function createCommand(): GroupTopologyReconfigureCommand {
    return {
        groupRef: createTopologyTestGroupRef(),
        commandId: 'reconfigure-request',
        actorPrincipalId: 'owner',
        capturedAtEpochMs: 1_000,
        requestOptions: { degreeLimit: 7 },
        publish: true
    } as const;
}

function createRead(): GroupTopologyReconfigureRead {
    return {
        authority: {
            group: createTopologyTestGroupSnapshot(),
            config: resolveGroupTopologyConfig({}),
            kindHysteresisWidths: { meshExitWidth: 4, treeExitWidth: 0 },
            rttMeasurements: [],
            replanning: 'auto' as const,
            nowEpochMs: 1_000
        },
        authorityGuard: createTopologyTestAuthorityGuard(),
        actorIsPlatformAdmin: false
    };
}
