import {
    decodeWsOutboxProvenance,
    type WsOutboxProvenance
} from '@shared-server/rallar-system/websocket/outbox/ws-outbox-provenance.ts';
import { assert, assertEquals } from '@std/assert';
import postgres from 'postgres';
import { waitForProofCondition } from '../cluster-proof-socket.mts';

/** Owns the isolated test database connection and exact listener fault, never an API administration hook. */
export class ViewPushProofPostgres {
    readonly #sql: ReturnType<typeof postgres>;

    constructor(databaseUrl: string) {
        this.#sql = postgres(databaseUrl, { max: 1 });
    }

    async readListener(applicationName: string): Promise<number> {
        const rows = await this.#sql<{ pid: number; }[]>`
            select pid from pg_stat_activity
            where datname = current_database() and application_name = ${applicationName}
              and state = 'idle' and ltrim(query) ilike 'listen %'
        `;
        assertEquals(rows.length, 1, 'Exactly one dedicated LISTEN backend for this isolated API');
        return rows[0]!.pid;
    }

    async terminateListener(pid: number): Promise<void> {
        const rows = await this.#sql<{ terminated: boolean; }[]>`select pg_terminate_backend(${pid}) as terminated`;
        assertEquals(rows[0]?.terminated, true);
        await waitForProofCondition(async () => {
            const live = await this.#sql`select pid from pg_stat_activity where pid = ${pid}`;
            return live.length === 0;
        }, 'old LISTEN backend disappearance');
    }

    async waitForPublication(traceId: string): Promise<WsOutboxProvenance> {
        let proof: WsOutboxProvenance | null = null;
        await waitForProofCondition(async () => {
            const rows = await this.#sql<{ proof: string; status: string; }[]>`
                select proof.store_value as proof, outbox.ri_status as status
                from resource_inbox outbox join runtime_state_store proof
                  on proof.store_namespace = 'ws-outbox-provenance'
                  and proof.store_value::jsonb->>'messageId' = outbox.ri_resource::jsonb->'id'->>'msgId'
                where outbox.ri_type_id = 'WS_OUTBOX'
                  and outbox.ri_resource::jsonb->'route'->>'topicId' = 'view.invalidated'
                  and outbox.ri_resource::jsonb->'id'->>'traceId' = ${traceId}
            `;
            assert(rows.length <= 1, 'One own-account visibility publication');
            if (rows[0]?.status !== 'COMPLETED') {
                return false;
            }
            proof = decodeWsOutboxProvenance(JSON.parse(rows[0].proof));
            return true;
        }, 'committed view outbox publication completion');
        assert(proof !== null);
        return proof;
    }

    async close(): Promise<void> {
        await this.#sql.end();
    }
}
