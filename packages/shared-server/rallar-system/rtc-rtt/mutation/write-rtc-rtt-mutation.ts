import type { PSqlSql } from '../../../postgres/p-sql-sql.ts';
import { RuntimeStateWriteConflictError } from '../../../runtime-state/optimistic-runtime-state-write.ts';
import {
    createTransactionBoundPSqlRuntimeStateRepository
} from '../../../runtime-state/postgres/p-sql-runtime-state-repository.ts';
import type {
    RuntimeStateConditionalRepositoryLike,
    RuntimeStateConditionalWriteResult
} from '../../../runtime-state/runtime-state-repository.ts';

import { writeAppOutboxInsert } from '../../app-outbox/app-outbox-insert.ts';
import type { RtcRttMutationComputed, RtcRttRuntimeWrite } from './rtc-rtt-mutation-contracts.ts';

export interface WriteRtcRttMutationInput {
    readonly transaction: PSqlSql;
    readonly computed: Extract<RtcRttMutationComputed, { outcome: 'write'; }>;
}

export async function writeRtcRttMutation(input: WriteRtcRttMutationInput): Promise<'accepted'> {
    const computed = input.computed;
    const runtime = createTransactionBoundPSqlRuntimeStateRepository(input.transaction);
    for (const write of computed.runtimeWrites) {
        requireAcceptedRttWrite(await executeRtcRttRuntimeWrite(runtime, write));
    }
    for (const outboxWrite of computed.outboxWrites) {
        await writeAppOutboxInsert(input.transaction, outboxWrite);
    }
    return 'accepted';
}

async function executeRtcRttRuntimeWrite(
    repository: RuntimeStateConditionalRepositoryLike,
    write: RtcRttRuntimeWrite
): Promise<RuntimeStateConditionalWriteResult> {
    return write.expectedRevision === null
        ? await repository.insertIfAbsent(
            write.namespace,
            write.key,
            write.value,
            write.expireAtIsoTimestamp
        )
        : await repository.upsertIfRevision(
            write.namespace,
            write.key,
            write.value,
            write.expireAtIsoTimestamp,
            write.expectedRevision
        );
}

function requireAcceptedRttWrite(result: RuntimeStateConditionalWriteResult): void {
    if (result.status === 'conflict') {
        throw new RuntimeStateWriteConflictError();
    }
}
