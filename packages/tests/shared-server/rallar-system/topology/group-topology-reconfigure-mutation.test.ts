import type { PSqlParameter, PSqlSql } from '@shared-server/postgres/p-sql-sql.ts';
import { describe, expect, it, vi } from 'vitest';

import { resolveGroupTopologyConfig } from '@shared-server/rallar-system/topology/config/group-topology-config.ts';
import { RtcTopologyOutboxWriter } from '@shared-server/rallar-system/topology/mutation/rtc-topology-outbox-writer.ts';
import { GroupTopologyReconfigureMutation } from '@shared-server/rallar-system/topology/reconfigure/group-topology-reconfigure-mutation.ts';

import {
    createTopologyTestAuthorityGuard,
    createTopologyTestGroupRef,
    createTopologyTestGroupSnapshot
} from './config/mutation/group-topology-config-mutation-test-fixtures.ts';

describe('GroupTopologyReconfigureMutation', () => {
    it('computes the deterministic explicit outbox intent from the captured command', () => {
        const mutation = createMutation();
        const command = createCommand();
        const read = createRead();

        const computed = mutation.compute(command, read);

        expect(computed).toMatchObject({
            commandId: 'reconfigure-request',
            resourceId: 'reconfigure-request:rtc-topology-recompute:explicit',
            // The route commands a replan, so its work must not be stamped
            // automatic: the planner freezes automatic work under `commanded`
            // and `corrupt`, which would discard the command in exactly the
            // mode that exists to honour it (product decision 4).
            origin: 'commanded',
            aggregateRef: createTopologyTestGroupRef(),
            acceptedCausalRevision: { groupRevision: 1, presenceRevision: 1 },
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
        expect(() => mutation.validate(command, read, computed)).not.toThrow();
    });

    it('rejects a non-admin actor who cannot update the current group', () => {
        const mutation = createMutation();
        const command = { ...createCommand(), actorPrincipalId: 'intruder' };
        const read = createRead();

        expect(() => mutation.validate(command, read, mutation.compute(command, read))).toThrow(
            'Forbidden: An active group member is required for this operation.'
        );
    });

    it('uses only the administrator decision captured in read', () => {
        const command = { ...createCommand(), actorPrincipalId: 'intruder' };
        const mutation = createMutation(() => {
            throw new Error('Validate must not reread administrator authority');
        });
        const callerDeniedCommand = { ...command, isPlatformAdmin: false };
        const callerAllowedCommand = { ...command, isPlatformAdmin: true };

        expect(() =>
            mutation.validate(
                callerDeniedCommand,
                createRead(true),
                mutation.compute(callerDeniedCommand, createRead(true))
            )
        ).not.toThrow();
        expect(() =>
            mutation.validate(
                callerAllowedCommand,
                createRead(false),
                mutation.compute(callerAllowedCommand, createRead(false))
            )
        ).toThrow('Forbidden: An active group member is required for this operation.');
    });

    it.each([
        ['publication flag', (computed: object) => ({ ...computed, publish: false })],
        ['payload kind', (computed: object) => ({ ...computed, payloadKind: 'snapshot' })],
        ['request options', (computed: object) => ({ ...computed, requestOptions: { topologyKind: 'tree', unexpected: true } })],
        [
            'aggregate identity',
            (computed: ReturnType<GroupTopologyReconfigureMutation['compute']>) => ({
                ...computed,
                aggregateRef: { ...computed.aggregateRef, groupId: 'other-group' }
            })
        ]
    ])('rejects an altered %s before the transaction boundary', (_label, corrupt) => {
        const mutation = createMutation();
        const command = createCommand();
        const read = createRead();
        const computed = corrupt(mutation.compute(command, read));

        expect(() => Reflect.apply(mutation.validate, mutation, [command, read, computed])).toThrow(
            'Topology reconfigure computation is invalid'
        );
    });

    it('writes the computed authority and outbox without decoding in the transaction', async () => {
        const mutation = createMutation();
        const command = createCommand();
        const read = createRead();
        const computed = mutation.compute(command, read);
        mutation.validate(command, read, computed);
        const parse = vi.spyOn(JSON, 'parse').mockImplementation(() => {
            throw new Error('Decoding entered the transaction');
        });

        try {
            await expect(mutation.write(createSuccessfulTransaction(), computed)).resolves.toBeUndefined();
        }
        finally {
            parse.mockRestore();
        }
    });
});

function createSuccessfulTransaction(): PSqlSql {
    const sql = (
        stringsOrValues: TemplateStringsArray | readonly PSqlParameter[],
        ..._values: readonly PSqlParameter[]
    ): Promise<readonly object[]> | object => {
        if (Array.isArray(stringsOrValues) && !Object.hasOwn(stringsOrValues, 'raw')) {
            return {};
        }
        const query = (stringsOrValues as TemplateStringsArray).join(' ');
        return Promise.resolve(
            query.includes('returning ri_row_id') ? [{ ri_row_id: 1n }] : [{ revision: 1 }]
        );
    };
    return Object.assign(sql, {
        begin: async <T>(_write: (transaction: PSqlSql) => Promise<T>): Promise<T> => {
            throw new Error('Reconfigure write must not open a transaction');
        }
    }) as PSqlSql;
}

function createMutation(
    isPlatformAdmin: (principalId: string) => boolean = () => false
): GroupTopologyReconfigureMutation {
    return new GroupTopologyReconfigureMutation({
        groupStateRepository: {} as never,
        readPlanningAuthority: async () => createRead().authority,
        isPlatformAdmin,
        outboxWriter: new RtcTopologyOutboxWriter({ recordWrite: () => undefined })
    });
}

function createCommand() {
    return {
        groupRef: createTopologyTestGroupRef(),
        commandId: 'reconfigure-request',
        actorPrincipalId: 'owner',
        capturedAtEpochMs: 1_000,
        requestOptions: { degreeLimit: 7 },
        publish: true
    } as const;
}

function createRead(actorIsPlatformAdmin = false) {
    return {
        authority: {
            group: createTopologyTestGroupSnapshot(),
            config: resolveGroupTopologyConfig({}),
            kindHysteresisWidths: { meshExitWidth: 4, treeExitWidth: 0 },
            rttReportingDegreeLimit: 5,
            rttMeasurements: [],
            replanning: 'auto' as const,
            nowEpochMs: 1_000
        },
        authorityGuard: createTopologyTestAuthorityGuard(),
        actorIsPlatformAdmin
    };
}
