import type { PSqlSql } from '../../../../postgres/p-sql-sql.ts';
import { runInPSqlTransaction } from '../../../../postgres/run-in-p-sql-transaction.ts';
import type { ResourceInboxReservationFinish } from '../../../../queuebox/postgres/resource-inbox-reservation-write.ts';
import { RuntimeStateWriteConflictError } from '../../../../runtime-state/optimistic-runtime-state-write.ts';
import {
    writeAppOutboxInserts,
    type AppOutboxInsert
} from '../../../app-outbox/app-outbox-insert.ts';
import type { RtcTopologyMutationComputed } from '../../mutation/rtc-topology-mutations.ts';
import type { RtcTopologyExecutionRepository } from '../../persistence/rtc-topology-execution-repository.ts';
import type { RtcTopologyReshapeGateWrite } from '../../persistence/rtc-topology-reshape-gate-store.ts';
import type { RtcTopologyPublication } from '../../publication/rtc-topology-publication.ts';
import {
    computeRtcTopologyPublicationOutboxWrites
} from '../../publication/rtc-topology-ws-outbox-entry.ts';
import type { RtcTopologyDeliveryAppendPort } from '../delivery/rtc-topology-delivery-append-port.ts';
import type { RtcTopologyDeliveryAppend } from '../delivery/rtc-topology-delivery-contracts.ts';
import { RtcTopologyDeliveryLeaseLostError } from '../delivery/rtc-topology-delivery-stream-service.ts';
import {
    computeRtcTopologyDeliveryAppend,
    isRtcTopologyDeliveryRetryableConflict
} from '../delivery/rtc-topology-delivery-validation.ts';
import type { RtcTopologyInputFingerprintWrite } from './rtc-topology-input-fingerprint.ts';
import {
    finishRtcTopologyReservation
} from './rtc-topology-work-completion.ts';

export interface RtcTopologyPublicationTransactionWrite {
    readonly mutation: Extract<RtcTopologyMutationComputed, { outcome: 'write' | 'publish-superseded'; }> | null;
    readonly promotionWrite: AppOutboxInsert | null;
    readonly connectWrites: readonly AppOutboxInsert[];
    readonly fingerprint: RtcTopologyInputFingerprintWrite | null;
    /** The room's next reshape gate state; null when the work leaves the gate as it is. */
    readonly reshapeGate: RtcTopologyReshapeGateWrite | null;
    /** The row that wakes the room when a held reshape's gate opens; null when none is due. */
    readonly reshapeDueWrite: AppOutboxInsert | null;
    readonly delivery: RtcTopologyPublicationDeliveryWrite | null;
    readonly reservationFinish: ResourceInboxReservationFinish;
}

export interface RtcTopologyPublicationDeliveryWrite {
    readonly outboxWrites: readonly AppOutboxInsert[];
    readonly deliveryAppend: RtcTopologyDeliveryAppend | null;
}

interface RtcTopologyPublicationTransactionDependencies {
    readonly database: PSqlSql;
    readonly executionRepository: RtcTopologyExecutionRepository;
    readonly deliveryAppend: RtcTopologyDeliveryAppendPort | undefined;
}

/** Executes only computed writes; immutable delivery and reservation completion are atomic. */
export async function writeRtcTopologyPublicationTransaction(
    options: RtcTopologyPublicationTransactionDependencies,
    computed: RtcTopologyPublicationTransactionWrite
): Promise<void> {
    try {
        await runInPSqlTransaction(
            options.database,
            async (transaction) => await writeRtcTopologyPublicationTransactionBody(options, transaction, computed)
        );
    }
    catch (error) {
        if (error instanceof Error && isRtcTopologyDeliveryRetryableConflict(error)) {
            throw new RuntimeStateWriteConflictError();
        }
        throw error;
    }
}

/** The layout first, then the gate it was computed against, then the rows the commit wakes. */
async function writeRtcTopologyPublicationTransactionBody(
    options: RtcTopologyPublicationTransactionDependencies,
    transaction: PSqlSql,
    computed: RtcTopologyPublicationTransactionWrite
): Promise<void> {
    const { executionRepository } = options;
    if (computed.mutation) {
        await executionRepository.writeTopologyMutation(transaction, computed.mutation);
    }
    if (computed.reshapeGate) {
        await executionRepository.writeTopologyReshapeGate(transaction, computed.reshapeGate);
    }
    await writeAppOutboxInserts(transaction, [
        ...(computed.promotionWrite === null ? [] : [computed.promotionWrite]),
        ...computed.connectWrites,
        ...(computed.reshapeDueWrite === null ? [] : [computed.reshapeDueWrite]),
        ...(computed.delivery === null ? [] : computed.delivery.outboxWrites)
    ]);
    if (computed.fingerprint) {
        await executionRepository.writeTopologyInputFingerprint(transaction, computed.fingerprint);
    }
    if (computed.delivery) {
        await writePublicationDeliveryAppend(transaction, computed.delivery, options.deliveryAppend);
    }
    await finishRtcTopologyReservation(transaction, computed.reservationFinish);
}

export function computeRtcTopologyPublicationDeliveryWrite(
    publication: RtcTopologyPublication,
    publisherStreamId: string | undefined
): RtcTopologyPublicationDeliveryWrite {
    const outboxWrites = computeRtcTopologyPublicationOutboxWrites(publication);
    return {
        outboxWrites,
        deliveryAppend: publisherStreamId === undefined
            ? null
            : computeRtcTopologyDeliveryAppend(
                publisherStreamId,
                publication,
                outboxWrites.map((write) => write.entry)
            )
    };
}

async function writePublicationDeliveryAppend(
    transaction: PSqlSql,
    computed: RtcTopologyPublicationDeliveryWrite,
    append: RtcTopologyDeliveryAppendPort | undefined
): Promise<void> {
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
