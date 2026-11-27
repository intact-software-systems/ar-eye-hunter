import { describe, expect, it } from 'vitest';

import type { PSqlParameter, PSqlSql } from '@shared-server/postgres/p-sql-sql.ts';

import {
    createRoomSendInstance,
    type RoomSendInstanceConfig,
    type RoomSendInstanceInput
} from '../../../../../../apps/api-v1/scripts/perf/alm-room-send/instance/create-room-send-instance.ts';
import type { RoomSendClock } from '../../../../../../apps/api-v1/scripts/perf/alm-room-send/room-send-clock.ts';
import type { ApiV1DatabaseLifecycle } from '../../../../../../apps/api-v1/src/db/api-v1-database-lifecycle.ts';

const INPUT: RoomSendInstanceInput = {
    instanceIndex: 1,
    delayMs: 0,
    applicationPoolMaxConnections: 7,
    runId: '0f0e0d0c-0b0a-4908-8706-050403020100',
    scope: { applicationId: 'room-send-cell', workspaceId: 'default' },
    authorizeRoomMessage: () => false,
    recordHandOff: () => undefined
};

const CONFIG: RoomSendInstanceConfig = {
    queueResilience: { failureThreshold: 10, openDurationMs: 10_000, resetDurationMs: 10_000, samplingDurationMs: 10_000 }
};

const CLOCK: RoomSendClock = { nowMs: () => 0, nowEpochMs: () => 1_800_000_000_000, sleep: async () => undefined };

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

/** A handle that takes a statement and answers no rows; `statements` counts the statements sent through it. */
function createCountingSql(): { readonly sql: PSqlSql; readonly statements: () => number; } {
    let statements = 0;
    function sql<Result>(strings: TemplateStringsArray, ...values: readonly PSqlParameter[]): Promise<Result>;
    function sql(values: readonly PSqlParameter[]): object;
    function sql(): object {
        statements += 1;
        return Promise.resolve([]);
    }
    const counting = Object.assign(sql, {
        begin: async (): Promise<never> => {
            throw new Error('A transaction was opened on a handle that only counts statements.');
        }
    });
    return { sql: counting, statements: () => statements };
}

describe('createRoomSendInstance', () => {
    it('opens as many connections of its application pool as its input states, when it warms the pool', async () => {
        const database = createCountingSql();
        const instance = await createRoomSendInstance(INPUT, CONFIG, {
            lifecycle: {
                database: database.sql,
                notification: { notify: async () => undefined, listen: async () => undefined },
                readiness: Promise.resolve(),
                close: async () => undefined
            },
            clock: CLOCK
        });

        await instance.warmApplicationPool();
        await instance.stop();
        await instance.close();

        expect(instance.applicationPoolMaxConnections).toBe(7);
        expect(database.statements()).toBe(7);
    });

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

        const created = createRoomSendInstance(INPUT, CONFIG, { lifecycle: lifecycleWithoutNotifications, clock: CLOCK });

        await expect(created).rejects.toThrow('PostgreSQL notification port');
        expect(closes).toBe(1);
    });
});
