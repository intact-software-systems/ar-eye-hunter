import { Temporal } from '@js-temporal/polyfill';
import { NEVER_EXPIRE_AT_TIMESTAMP } from '@shared/persistence/PersistenceProvider.ts';
import { NotReadyException } from '@shared/queuebox/resource-inbox/not-ready-exception.ts';
import { ResourceInboxHandlerFinalizedSuccess } from '@shared/queuebox/resource-inbox/resource-inbox-handler-outcome.ts';
import { EntityStatus, type Key } from '@shared/queuebox/ResourceEntry.ts';
import { jsonEquals } from '@shared/repository/state-utils.ts';
import type { OutboxQueueReader } from '@shared/services/outbox-queue-reader.ts';
import type { PSqlSql } from '../../postgres/p-sql-sql.ts';
import { writeResourceInboxRetainedReservationFinish } from '../../queuebox/postgres/resource-inbox-reservation-write.ts';

import { decodeJsonWireText, type JsonWireValue } from '../protocol/json-wire-identity.ts';

export interface DurableDeadlineDelivery<Deadline> {
    readonly outboxQueueReader: OutboxQueueReader;
    readonly database: PSqlSql;
    readonly retentionMs: number;
    readonly nowEpochMs: () => number;
    readonly enqueue: (command: Deadline, traceId: string) => Promise<void>;
}

export function installDurableDeadline<Deadline extends { readonly dueAtEpochMs: number; }>(
    input: DurableDeadlineDelivery<Deadline> & {
        readonly typeId: string;
        readonly topicId: string;
        readonly decode: (value: JsonWireValue) => Deadline;
        readonly route: (deadline: Deadline) => Key;
    }
): void {
    input.outboxQueueReader.onOutboxMessageDo(input.typeId, {
        onMessage: async (message, entry) => {
            const deadline = input.decode(decodeJsonWireText(message.payload.resource, 'Durable deadline'));
            const route = input.route(deadline);
            if (
                !jsonEquals(message.route, route) || message.id.msgId !== route.resourceId ||
                message.payload.typeId !== input.typeId || message.targets !== undefined ||
                message.constraints?.expiresAtMs !== NEVER_EXPIRE_AT_TIMESTAMP
            ) {
                throw new TypeError('Deadline envelope differs from its durable identity');
            }
            const remainingMs = deadline.dueAtEpochMs - input.nowEpochMs();
            if (remainingMs > 0) {
                throw new NotReadyException(remainingMs, 'Deadline is still in the future on this worker');
            }
            await input.enqueue(deadline, message.id.traceId);
            // A crash between admission and finishing the wake repeats the same durable AppInbox command.
            const completedAt = input.nowEpochMs();
            const expiresAt = completedAt + input.retentionMs;
            const finished = await writeResourceInboxRetainedReservationFinish(input.database, {
                key: entry.key,
                expectedAttempts: entry.dequeueAudit.attempts,
                status: EntityStatus.COMPLETED,
                completedAt: new Date(completedAt),
                expiresAt: new Date(expiresAt)
            });
            if (!finished) {
                throw new Error('Deadline reservation has changed');
            }
            return new ResourceInboxHandlerFinalizedSuccess({
                ...entry,
                status: EntityStatus.COMPLETED,
                audit: { ...entry.audit, expiryTs: Temporal.Instant.fromEpochMilliseconds(expiresAt) },
                dequeueAudit: {
                    ...entry.dequeueAudit,
                    endTs: Temporal.Instant.fromEpochMilliseconds(completedAt),
                    nextTs: undefined
                }
            });
        }
    }, [input.topicId]);
}
