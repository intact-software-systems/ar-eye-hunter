import type { ResourceEntry } from '@shared/queuebox/ResourceEntry.ts';
import type { PSqlSql } from '../../../../postgres/p-sql-sql.ts';
import { runInPSqlTransaction } from '../../../../postgres/run-in-p-sql-transaction.ts';
import { RuntimeStateWriteConflictError } from '../../../../runtime-state/optimistic-runtime-state-write.ts';
import type { RtcTopologyPublication } from '../../publication/rtc-topology-publication.ts';
import { writeRtcTopologyPublicationOutbox } from '../../publication/rtc-topology-ws-outbox-entry.ts';
import type { RtcTopologyDeliveryAppendPort } from '../delivery/rtc-topology-delivery-append-port.ts';
import { RtcTopologyDeliveryLeaseLostError } from '../delivery/rtc-topology-delivery-stream-service.ts';
import {
    isRtcTopologyDeliveryRetryableConflict,
    toRtcTopologyDeliveryAppendInput
} from '../delivery/rtc-topology-delivery-validation.ts';
import { finishRtcTopologyReservation } from './finish-rtc-topology-work.ts';

export interface RtcTopologyDeliveryOptions {
    readonly publisherStreamId: string;
    readonly append: RtcTopologyDeliveryAppendPort;
}

/** Publication, immutable delivery records and reservation completion share one transaction. */
export async function writeRtcTopologyPublicationTransaction(
    options: { readonly database: PSqlSql; },
    entry: ResourceEntry,
    write: (transaction: PSqlSql) => Promise<void>
): Promise<void> {
    try {
        await runInPSqlTransaction(options.database, async (transaction) => {
            await write(transaction);
            await finishRtcTopologyReservation(transaction, entry);
        });
    }
    catch (error) {
        if (error instanceof Error && isRtcTopologyDeliveryRetryableConflict(error)) {
            throw new RuntimeStateWriteConflictError();
        }
        throw error;
    }
}

export async function writePublicationDelivery(
    transaction: PSqlSql,
    publication: RtcTopologyPublication,
    delivery: RtcTopologyDeliveryOptions | undefined
): Promise<void> {
    const outbox = await writeRtcTopologyPublicationOutbox(transaction, publication);
    if (!delivery) {
        return;
    }
    const result = await delivery.append.appendOrValidate(
        transaction,
        toRtcTopologyDeliveryAppendInput(delivery.publisherStreamId, publication, outbox)
    );
    if (result.status === 'conflict') {
        throw new RuntimeStateWriteConflictError();
    }
    if (result.status === 'lease-lost') {
        throw new RtcTopologyDeliveryLeaseLostError(
            `RTC topology publisher stream ${delivery.publisherStreamId} lost its lease`
        );
    }
}
