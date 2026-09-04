import { Temporal } from '@js-temporal/polyfill';
import type {
    PSqlParameter,
    PSqlSql
} from '@shared-server/postgres/p-sql-sql.ts';
import {
    ResourceInboxInvariantCorruptionError
} from '@shared-server/queuebox/postgres/p-sql-resource-inbox-entry-repository.ts';
import {
    computeAppOutboxInsert,
    writeAppOutboxInsert
} from '@shared-server/rallar-system/app-outbox/app-outbox-insert.ts';
import {
    computeTopologyPromotionRequest,
    readTopologyPromotion
} from '@shared-server/rallar-system/topology/replay/work/topology-promotion-request.ts';
import { EntityStatus, type ResourceEntry } from '@shared/queuebox/ResourceEntry.ts';
import { describe, expect, it } from 'vitest';
import { createTestGroup } from '../../../../../create-test-group.ts';

describe('topology promotion request write', () => {
    it('reads current authority before pure promotion selection', async () => {
        const calls: string[] = [];
        const group = createTestGroup({ lifecycleState: 'active' });
        const read = await readTopologyPromotion({
            groupRef: group,
            publication: {
                findCurrentGroup: async () => {
                    calls.push('group');
                    return group;
                },
                readLifecyclePolicy: async () => {
                    calls.push('policy');
                    return { status: 'absent' };
                }
            }
        });

        expect(calls).toEqual(['group', 'policy']);
        expect(computeTopologyPromotionRequest({
            read,
            serviceId: 'topology-service',
            entry: promotionEntry(),
            target: null
        })).toBeNull();
        expect(calls).toEqual(['group', 'policy']);
    });

    it('does not read policy for an inactive current group', async () => {
        const group = createTestGroup({ lifecycleState: 'dormant' });
        let policyReads = 0;

        const read = await readTopologyPromotion({
            groupRef: group,
            publication: {
                findCurrentGroup: async () => group,
                readLifecyclePolicy: async () => {
                    policyReads += 1;
                    return { status: 'absent' };
                }
            }
        });

        expect(read).toEqual({ group, policy: null });
        expect(policyReads).toBe(0);
    });

    it('rejects an immutable ResourceInbox collision', async () => {
        const entry = promotionEntry();
        const computed = computeAppOutboxInsert(entry);

        await expect(
            writeAppOutboxInsert(createConflictingTransaction(), computed)
        ).rejects.toBeInstanceOf(ResourceInboxInvariantCorruptionError);
    });
});

function promotionEntry(): ResourceEntry {
    const createdTs = Temporal.PlainDateTime.from('2026-01-02T03:04:05');
    return {
        key: {
            topicId: 'topology-promotion',
            resourceId: 'promotion-1',
            contextId: 'group-1'
        },
        resource: '{"promotion":1}',
        typeId: 'APP_OUTBOX',
        status: EntityStatus.NEW,
        audit: {
            date: createdTs.toPlainTime(),
            createdBy: 'topology-service',
            createdTs,
            expiryTs: Temporal.Instant.from('9999-12-31T23:59:59.999Z')
        },
        dequeueAudit: { attempts: 0 }
    };
}

function createConflictingTransaction(): PSqlSql {
    function sql<Result>(
        _strings: TemplateStringsArray,
        ..._values: readonly PSqlParameter[]
    ): Promise<Result>;
    function sql(_values: readonly PSqlParameter[]): object;
    function sql(
        stringsOrValues: TemplateStringsArray | readonly PSqlParameter[]
    ): Promise<readonly object[]> | object {
        return Array.isArray(stringsOrValues) && !Object.hasOwn(stringsOrValues, 'raw')
            ? {}
            : Promise.resolve([]);
    }
    return Object.assign(sql, {
        begin: async <T>(_write: (transaction: PSqlSql) => Promise<T>): Promise<T> => {
            throw new Error('Topology promotion write must not open a transaction');
        }
    });
}
