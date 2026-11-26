import { describe, expect, it } from 'vitest';

import type { PSqlParameter, PSqlSql } from '@shared-server/postgres/p-sql-sql.ts';

import {
    createOrderedSendInstance,
    type OrderedSendInstanceConfig,
    type OrderedSendInstanceInput
} from '../../../../../apps/api-v1/scripts/perf/alm-ordered-send/create-ordered-send-instance.ts';
import type { OrderedSendClock } from '../../../../../apps/api-v1/scripts/perf/alm-ordered-send/ordered-send-clock.ts';
import type { ApiV1DatabaseLifecycle } from '../../../../../apps/api-v1/src/db/api-v1-database-lifecycle.ts';

const INPUT: OrderedSendInstanceInput = {
    instanceIndex: 1,
    delayMs: 0,
    runId: '0f0e0d0c-0b0a-4908-8706-050403020100',
    scope: { applicationId: 'ordered-send-cell', workspaceId: 'default' },
    authorizeRoomMessage: () => false,
    recordHandOff: () => undefined
};

const CONFIG: OrderedSendInstanceConfig = {
    applicationPoolMaxConnections: 5,
    queueResilience: { failureThreshold: 10, openDurationMs: 10_000, resetDurationMs: 10_000, samplingDurationMs: 10_000 }
};

const CLOCK: OrderedSendClock = { nowMs: () => 0, nowEpochMs: () => 1_800_000_000_000, sleep: async () => undefined };

/** A handle nothing is sent through: an instance that fails to be wired has sent no statement. */
function createUnusedSql(): PSqlSql {
    function sql<Result>(strings: TemplateStringsArray, ...values: readonly PSqlParameter[]): Promise<Result>;
    function sql(values: readonly PSqlParameter[]): object;
    function sql(): object {
        throw new Error('A statement was sent through the handle of an instance that was never wired.');
    }
    return Object.assign(sql, {
        begin: async (): Promise<never> => {
            throw new Error('A transaction was opened on the handle of an instance that was never wired.');
        }
    });
}

describe('createOrderedSendInstance', () => {
    it('closes the lifecycle it was given when it cannot wire an instance over it, and fails with the reason', async () => {
        let closes = 0;
        const lifecycleWithoutNotifications: ApiV1DatabaseLifecycle = {
            database: createUnusedSql(),
            notification: null,
            readiness: Promise.resolve(),
            close: async () => {
                closes += 1;
            }
        };

        const created = createOrderedSendInstance(INPUT, CONFIG, { lifecycle: lifecycleWithoutNotifications, clock: CLOCK });

        await expect(created).rejects.toThrow('PostgreSQL notification port');
        expect(closes).toBe(1);
    });
});
