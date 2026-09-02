import type { PSqlSql } from '../../../postgres/p-sql-sql.ts';
import { RuntimeStateWriteConflictError } from '../../../runtime-state/optimistic-runtime-state-write.ts';
import { decodeRuntimeStateRevision } from '../../../runtime-state/postgres/runtime-state-row-codec.ts';

import type { RtcTopologyOutboxWriter } from '../../topology/mutation/rtc-topology-outbox-writer.ts';
import type { RtcRttMutationComputed, RtcRttRuntimeWrite } from './rtc-rtt-mutation-contracts.ts';

export interface WriteRtcRttMutationInput {
    readonly transaction: PSqlSql;
    readonly computed: Extract<RtcRttMutationComputed, { outcome: 'write'; }>;
    readonly outboxWriter: RtcTopologyOutboxWriter;
}

export async function writeRtcRttMutation(input: WriteRtcRttMutationInput): Promise<'accepted'> {
    for (const write of input.computed.runtimeWrites) {
        requireExpectedRevision(write, await executeRuntimeWrite(input.transaction, write));
    }
    for (const outboxWrite of input.computed.outboxWrites) {
        await input.outboxWriter.write(input.transaction, outboxWrite);
    }
    return 'accepted';
}

async function executeRuntimeWrite(
    transaction: PSqlSql,
    write: RtcRttRuntimeWrite
): Promise<number | null> {
    const rows = write.operation === 'insert'
        ? await transaction<readonly { revision: number | string; }[]>`
            insert into runtime_state_store (store_namespace,
                                             store_key,
                                             store_value,
                                             expire_at_ts,
                                             updated_ts,
                                             revision)
            values (${write.namespace},
                    ${write.key},
                    ${write.value},
                    ${write.expireAtIsoTimestamp},
                    now(),
                    0)
            on conflict (store_namespace, store_key) do nothing
            returning revision
        `
        : await transaction<readonly { revision: number | string; }[]>`
            update runtime_state_store
            set store_value = ${write.value},
                expire_at_ts = ${write.expireAtIsoTimestamp},
                updated_ts = now(),
                revision = revision + 1
            where store_namespace = ${write.namespace}
              and store_key = ${write.key}
              and revision = ${write.expectedRevision}
            returning revision
        `;
    return rows[0] ? decodeRuntimeStateRevision(rows[0].revision) : null;
}

function requireExpectedRevision(write: RtcRttRuntimeWrite, revision: number | null): void {
    if (revision !== write.expectedResultRevision) {
        throw new RuntimeStateWriteConflictError();
    }
}
