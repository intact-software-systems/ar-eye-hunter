import type { OutboxQueueReader } from '@shared/services/outbox-queue-reader.ts';
import { AppOutboxType } from '../../app-outbox/app-outbox-type.ts';
import {
    decodeGroupSessionDeadline,
    GROUP_SESSION_DEADLINE_TOPIC,
    toGroupSessionDeadlineRoute,
    type GroupSessionDeadline
} from './group-session-deadline.ts';

export interface InstallGroupSessionDeadlineInput {
    readonly outboxQueueReader: OutboxQueueReader;
    readonly enqueue: (command: GroupSessionDeadline, traceId: string) => Promise<void>;
    readonly nowEpochMs: () => number;
}

export function installGroupSessionDeadline(input: InstallGroupSessionDeadlineInput): void {
    input.outboxQueueReader.onOutboxMessageDo(AppOutboxType.GROUP_SESSION_DEADLINE, {
        onMessage: async (message) => {
            const deadline = decodeGroupSessionDeadline(JSON.parse(message.payload.resource));
            const expected = toGroupSessionDeadlineRoute(deadline);
            if (
                message.route.topicId !== expected.topicId || message.route.resourceId !== expected.resourceId ||
                message.route.contextId !== expected.contextId || deadline.dueAtEpochMs <= message.id.ts
            ) {
                throw new TypeError('Session deadline envelope identity differs');
            }
            if (input.nowEpochMs() < deadline.dueAtEpochMs) {
                throw new Error('Session deadline is not due');
            }
            await input.enqueue(deadline, message.id.traceId);
        }
    }, [GROUP_SESSION_DEADLINE_TOPIC]);
}
