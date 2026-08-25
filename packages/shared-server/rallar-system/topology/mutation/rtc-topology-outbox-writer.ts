import type { ResourceEntry } from '@shared/queuebox/ResourceEntry.ts';

import type { PSqlSql } from '../../../postgres/p-sql-sql.ts';
import { PSqlResourceInboxEntryRepository } from '../../../queuebox/postgres/p-sql-resource-inbox-entry-repository.ts';
import { computeRtcTopologyEntry, type ComputedRtcTopologyOutbox } from './rtc-topology-outbox-entry.ts';

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
        computed: ComputedRtcTopologyOutbox
    ): Promise<ResourceEntry> {
        const entry = computeRtcTopologyEntry(computed);
        await new PSqlResourceInboxEntryRepository(transaction).writeIfAbsentOrMatch(entry);
        try {
            this.dependencies.recordWrite();
        }
        catch {
            // Observability must never alter a durable topology write.
        }
        return entry;
    }
}
