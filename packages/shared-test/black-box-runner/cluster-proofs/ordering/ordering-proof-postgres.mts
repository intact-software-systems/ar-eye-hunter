import assert from 'node:assert/strict';
import postgres from 'postgres';
import { waitForProofCondition } from '../cluster-proof-socket.mts';

/** Reads the isolated test database's outbound records directly, never through an API administration hook. */
export class OrderingProofPostgres {
    readonly #sql: ReturnType<typeof postgres>;

    constructor(databaseUrl: string) {
        this.#sql = postgres(databaseUrl, { max: 1 });
    }

    /** The positions the dequeuing authority recorded for one message's audience; `null` when it recorded none. */
    async readSentPositions(msgId: string): Promise<Readonly<Record<string, number>> | null> {
        const rows = await this.#sql<{ store_value: string; }[]>`
            select store_value from runtime_state_store where store_key like ${'%:sent:' + msgId}
        `;
        assert.ok(rows.length === 1, `One sent record for ${msgId}, found ${rows.length}`);
        return JSON.parse(rows[0]!.store_value).sentPositions ?? null;
    }

    async waitForOutboxCompleted(msgId: string): Promise<void> {
        await waitForProofCondition(async () => {
            const rows = await this.#sql<{ status: string; }[]>`
                select ri_status as status from resource_inbox
                where ri_type_id = 'WS_OUTBOX' and ri_resource::jsonb->'id'->>'msgId' = ${msgId}
            `;
            assert.ok(rows.length <= 1, 'One outbox row per message');
            return rows[0]?.status === 'COMPLETED';
        }, `outbox completion of ${msgId}`);
    }

    async close(): Promise<void> {
        await this.#sql.end();
    }
}
