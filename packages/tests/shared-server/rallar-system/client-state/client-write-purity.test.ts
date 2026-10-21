import {
    describe,
    expect,
    it
} from 'vitest';

import type { PSqlParameter, PSqlSql } from '@shared-server/postgres/p-sql-sql.ts';
import type { AppOutboxInsertRow } from '@shared-server/rallar-system/app-outbox/app-outbox-insert.ts';
import { computeClientMutation } from '@shared-server/rallar-system/client-state/mutation/compute/compute-client-mutation.ts';
import { writeClientMutation } from '@shared-server/rallar-system/client-state/mutation/write-client-mutation.ts';
import { assertClientMutationMatchesRecompute } from '@shared-test/shared-server/assert-client-mutation-matches-recompute.ts';

import { emptyRead, principalCommand } from './client-mutation-compute-test-fixtures.ts';

describe('client mutation write purity', () => {
    it('serializes runtime and event rows during compute', async () => {
        const command = principalCommand('write-purity');
        const computed = computeClientMutation({ command, read: emptyRead(command) });
        expect(computed.outcome).toBe('write');
        if (computed.outcome !== 'write') {
            return;
        }
        expect(computed.persistence.runtimeWrites.length).toBeGreaterThan(0);

        const stringify = JSON.stringify;
        JSON.stringify = () => {
            throw new Error('client serialization must finish during compute');
        };
        try {
            await expect(writeClientMutation(appliedSql(), computed)).resolves.toEqual(
                computed.receipt
            );
        }
        finally {
            JSON.stringify = stringify;
        }
    });

    it('rejects a persistence projection that differs from the computed domain result', () => {
        const command = principalCommand('write-purity-validation');
        const read = emptyRead(command);
        const computed = computeClientMutation({ command, read });
        expect(computed.outcome).toBe('write');
        if (computed.outcome !== 'write') {
            return;
        }
        const tampered = {
            ...computed,
            persistence: {
                ...computed.persistence,
                runtimeWrites: computed.persistence.runtimeWrites.map((operation, index) =>
                    index === 0 ? { ...operation, key: `${operation.key}:tampered` } : operation
                )
            }
        };

        expect(() => assertClientMutationMatchesRecompute({ command, read, computed: tampered })).toThrow(
            'Client mutation computed.persistence.runtimeWrites.0.key differs from the computed value'
        );
    });
});

/** Applies every statement: a runtime row returns its revision and each outbox row returns its identity. */
function appliedSql(): PSqlSql {
    const sql = (
        stringsOrValues: TemplateStringsArray | readonly PSqlParameter[],
        ...values: readonly PSqlParameter[]
    ): Promise<readonly object[]> | object => {
        if (!('raw' in stringsOrValues) || !stringsOrValues.join('').includes('insert into resource_inbox')) {
            return Promise.resolve([{ revision: 0 }]);
        }
        const rows = values[0] as readonly AppOutboxInsertRow[];
        return Promise.resolve(rows.map((row) => ({
            ri_resource_id: row.resourceId,
            ri_topic_id: row.topicId,
            fk_ext_bank_id: row.contextId
        })));
    };
    return sql as PSqlSql;
}
