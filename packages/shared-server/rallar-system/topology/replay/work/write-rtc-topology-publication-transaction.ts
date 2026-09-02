import type { PSqlSql } from '../../../../postgres/p-sql-sql.ts';
import { RuntimeStateWriteConflictError } from '../../../../runtime-state/optimistic-runtime-state-write.ts';
import { writeRtcTopologyPublicationOutbox } from '../../publication/rtc-topology-ws-outbox-entry.ts';
import { RtcTopologyDeliveryLeaseLostError } from '../delivery/rtc-topology-delivery-stream-service.ts';
import {
    type RtcTopologyPublicationDeliveryComputed
} from '../delivery/rtc-topology-delivery-validation.ts';
import { appendOrValidateRtcTopologyDelivery } from '../postgres/p-sql-rtc-topology-delivery-repository.ts';

export interface RtcTopologyDeliveryOptions {
    readonly publisherStreamId: string;
}

export async function writePublicationDelivery(
    transaction: PSqlSql,
    computed: RtcTopologyPublicationDeliveryComputed
): Promise<void> {
    await writeRtcTopologyPublicationOutbox(transaction, computed.outboxWrite);
    if (computed.appendInput === null) {
        return;
    }
    const result = await appendOrValidateRtcTopologyDelivery(
        transaction,
        computed.appendInput
    );
    if (result.status === 'conflict') {
        throw new RuntimeStateWriteConflictError();
    }
    if (result.status === 'lease-lost') {
        throw new RtcTopologyDeliveryLeaseLostError(
            'RTC topology publisher stream lost its lease'
        );
    }
}
