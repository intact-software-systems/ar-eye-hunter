import type { ResourceEntry } from '@shared/queuebox/ResourceEntry.ts';
import type { PSqlSql } from '../../../../postgres/p-sql-sql.ts';
import { runInPSqlTransaction } from '../../../../postgres/run-in-p-sql-transaction.ts';
import type { ResourceInboxReservationFinish } from '../../../../queuebox/postgres/resource-inbox-reservation-write.ts';
import { RuntimeStateWriteConflictError } from '../../../../runtime-state/optimistic-runtime-state-write.ts';
import type { AppOutboxInsert } from '../../../app-outbox/app-outbox-insert.ts';
import type { RtcTopologyMutationComputed } from '../../mutation/rtc-topology-mutations.ts';
import type { RtcTopologyExecutionRepository } from '../../persistence/rtc-topology-execution-repository.ts';
import type { RtcTopologyPublication } from '../../publication/rtc-topology-publication.ts';
import {
    computeRtcTopologyPublicationOutboxInsert,
    writeRtcTopologyPublicationOutbox
} from '../../publication/rtc-topology-ws-outbox-entry.ts';
import type { RtcTopologyDeliveryAppendPort } from '../delivery/rtc-topology-delivery-append-port.ts';
import type { RtcTopologyDeliveryAppendInput } from '../delivery/rtc-topology-delivery-contracts.ts';
import { RtcTopologyDeliveryLeaseLostError } from '../delivery/rtc-topology-delivery-stream-service.ts';
import {
    isRtcTopologyDeliveryRetryableConflict,
    toRtcTopologyDeliveryAppendInput
} from '../delivery/rtc-topology-delivery-validation.ts';
import type { RtcTopologyInputFingerprintWrite } from './rtc-topology-input-fingerprint.ts';
import {
    finishRtcTopologyReservation
} from './rtc-topology-work-completion.ts';
import { writeTopologyPromotionRequest } from './topology-promotion-request.ts';
import { writeGroupConnectTriggerRequests } from './write-group-connect-trigger-requests.ts';

export interface RtcTopologyDeliveryOptions {
    readonly publisherStreamId: string;
    readonly append: RtcTopologyDeliveryAppendPort;
}

export interface RtcTopologyPublicationTransactionWrite {
    readonly mutation: Extract<RtcTopologyMutationComputed, { outcome: 'write' | 'publish-superseded'; }> | null;
    readonly promotionRequest: ResourceEntry | null;
    readonly connectRequests: readonly ResourceEntry[];
    readonly fingerprint: RtcTopologyInputFingerprintWrite | null;
    readonly delivery: RtcTopologyPublicationDeliveryWrite | null;
    readonly reservationFinish: ResourceInboxReservationFinish;
}

/** Executes only computed writes; immutable delivery and reservation completion are atomic. */
export async function writeRtcTopologyPublicationTransaction(
    options: Readonly<{
        database: PSqlSql;
        executionRepository: RtcTopologyExecutionRepository;
        deliveryAppend: RtcTopologyDeliveryAppendPort | undefined;
    }>,
    computed: RtcTopologyPublicationTransactionWrite
): Promise<void> {
    try {
        await runInPSqlTransaction(options.database, async (transaction) => {
            if (computed.mutation) {
                await options.executionRepository.writeTopologyMutation(
                    transaction,
                    computed.mutation
                );
            }
            await writeTopologyPromotionRequest(transaction, computed.promotionRequest);
            await writeGroupConnectTriggerRequests(transaction, computed.connectRequests);
            if (computed.fingerprint) {
                await options.executionRepository.writeTopologyInputFingerprint(
                    transaction,
                    computed.fingerprint
                );
            }
            if (computed.delivery) {
                await writePublicationDelivery(
                    transaction,
                    computed.delivery,
                    options.deliveryAppend
                );
            }
            await finishRtcTopologyReservation(transaction, computed.reservationFinish);
        });
    }
    catch (error) {
        if (error instanceof Error && isRtcTopologyDeliveryRetryableConflict(error)) {
            throw new RuntimeStateWriteConflictError();
        }
        throw error;
    }
}

export interface RtcTopologyPublicationDeliveryWrite {
    readonly outboxWrite: AppOutboxInsert;
    readonly deliveryAppend: RtcTopologyDeliveryAppendInput | null;
}

export function computeRtcTopologyPublicationDeliveryWrite(
    publication: RtcTopologyPublication,
    publisherStreamId: string | undefined
): RtcTopologyPublicationDeliveryWrite {
    const outboxWrite = computeRtcTopologyPublicationOutboxInsert(publication);
    return {
        outboxWrite,
        deliveryAppend: publisherStreamId === undefined
            ? null
            : toRtcTopologyDeliveryAppendInput(
                publisherStreamId,
                publication,
                outboxWrite.entry
            )
    };
}

export async function writePublicationDelivery(
    transaction: PSqlSql,
    computed: RtcTopologyPublicationDeliveryWrite,
    append: RtcTopologyDeliveryAppendPort | undefined
): Promise<void> {
    await writeRtcTopologyPublicationOutbox(transaction, computed.outboxWrite);
    if (!append || computed.deliveryAppend === null) {
        return;
    }
    const result = await append.appendOrValidate(
        transaction,
        computed.deliveryAppend
    );
    if (result.status === 'conflict') {
        throw new RuntimeStateWriteConflictError();
    }
    if (result.status === 'lease-lost') {
        throw new RtcTopologyDeliveryLeaseLostError(
            `RTC topology publisher stream ${computed.deliveryAppend.publisherStreamId} lost its lease`
        );
    }
}
