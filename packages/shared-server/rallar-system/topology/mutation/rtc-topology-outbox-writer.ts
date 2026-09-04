import type { PSqlSql } from '../../../postgres/p-sql-sql.ts';
import {
    writeAppOutboxInsert,
    type AppOutboxInsert
} from '../../app-outbox/app-outbox-insert.ts';

// deno-lint-ignore no-namespace
export namespace RtcTopologyOutboxWriter {
    export interface Dependencies {
        readonly recordWrite: () => void;
    }
}

export class RtcTopologyOutboxWriter {
    private readonly dependencies: RtcTopologyOutboxWriter.Dependencies;

    constructor(dependencies: RtcTopologyOutboxWriter.Dependencies) {
        this.dependencies = dependencies;
    }

    async write(
        transaction: PSqlSql,
        computed: AppOutboxInsert
    ): Promise<void> {
        await writeAppOutboxInsert(transaction, computed);
    }

    recordCommittedWrites(count: number): void {
        for (let index = 0; index < count; index += 1) {
            try {
                this.dependencies.recordWrite();
            }
            catch {
                // Observability must never alter a durable topology write.
            }
        }
    }
}
