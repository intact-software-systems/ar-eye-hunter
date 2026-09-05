import { describe, expect, it } from 'vitest';

import type { PSqlParameter, PSqlSql } from '@shared-server/postgres/p-sql-sql.ts';
import { computeClientMutation } from '@shared-server/rallar-system/client-state/mutation/compute/compute-client-mutation.ts';
import { assertClientMutationComputed } from '@shared-server/rallar-system/client-state/mutation/result-validation/validate-client-mutation.ts';
import { writeClientMutation } from '@shared-server/rallar-system/client-state/mutation/write-client-mutation.ts';

import { emptyRead, principalCommand } from './client-mutation-compute-test-fixtures.ts';

describe('client mutation write purity', () => {
    it('serializes runtime and event rows during compute', async () => {
        const command = await principalCommand('write-purity');
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

    it('rejects a persistence projection that differs from the computed domain result', async () => {
        const command = await principalCommand('write-purity-validation');
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

        expect(() => assertClientMutationComputed({ command, read, computed: tampered })).toThrow(
            'Client mutation computed.persistence.runtimeWrites.0.key differs from the computed value'
        );
    });
});

function appliedSql(): PSqlSql {
    const sql = (
        _stringsOrValues: TemplateStringsArray | readonly PSqlParameter[],
        ..._values: readonly PSqlParameter[]
    ): Promise<readonly Readonly<{ revision: number; }>[]> | object => Promise.resolve([{ revision: 0 }]);
    return sql as PSqlSql;
}
