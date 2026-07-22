import { Temporal } from '@js-temporal/polyfill';
import { EnqueuedType } from '@shared/api/api-config.ts';
import type { ALMessage } from '@shared/al-contracts/al-contract.ts';
import {
    EntityStatus,
    type ResourceEntry,
} from '@shared/queuebox/ResourceEntry.ts';
import {
    computeGroupPresenceSummaryEntry,
    type GroupPresenceSummaryWorkData,
} from '@shared-server/rallar-system/services/group-state-mutations.ts';

export type HandlerFinalizedSummaryScenario = Readonly<{
    name: string;
    accepted: boolean;
    entries(): Readonly<{
        reserved: ResourceEntry;
        current: ResourceEntry;
    }>;
}>;

export const HANDLER_FINALIZED_SUMMARY_SCENARIOS:
    readonly HandlerFinalizedSummaryScenario[] = [
        scenario('exact canonical summary family', true),
        scenario('unrelated APP_OUTBOX family', false, (reserved) => ({
            ...reserved,
            key: {
                topicId: 'app-outbox.unrelated',
                resourceId: 'unrelated-resource',
                contextId: 'unrelated-context',
            },
            resource: JSON.stringify({ family: 'unrelated' }),
        })),
        scenario('wrong summary topic', false, (reserved) =>
            updateMessage(reserved, (message) => ({
                ...message,
                route: { ...message.route, topicId: 'app-outbox.wrong-summary' },
            }))),
        scenario('wrong outer payload type', false, (reserved) =>
            updateMessage(reserved, (message) => ({
                ...message,
                payload: { ...message.payload, typeId: 'RTC_TOPOLOGY_RECOMPUTE' },
            }))),
        scenario('wrong nested envelope family', false, (reserved) =>
            updateEnvelope(reserved, (envelope) => ({
                ...envelope,
                type: 'RTC_TOPOLOGY_RECOMPUTE',
            }))),
        scenario('malformed summary JSON', false, (reserved) => ({
            ...reserved,
            resource: '{',
        })),
        scenario('changed immutable summary resource', false, undefined, (current) =>
            updateEnvelope(current, (envelope) => ({
                ...envelope,
                senderId: 'changed-after-handler-finalization',
            }))),
        scenario('wrong completed attempt', false, undefined, (current) => ({
            ...current,
            dequeueAudit: {
                ...current.dequeueAudit,
                attempts: current.dequeueAudit.attempts + 1,
            },
        })),
        scenario('wrong finalized status', false, undefined, (current) => ({
            ...current,
            status: EntityStatus.FAILED,
        })),
    ];

function scenario(
    name: string,
    accepted: boolean,
    mutateReserved?: (entry: ResourceEntry) => ResourceEntry,
    mutateCurrent?: (entry: ResourceEntry) => ResourceEntry,
): HandlerFinalizedSummaryScenario {
    return {
        name,
        accepted,
        entries: () => {
            const canonical = createReservedSummaryEntry();
            const reserved = mutateReserved?.(canonical) ?? canonical;
            const completed: ResourceEntry = {
                ...reserved,
                status: EntityStatus.COMPLETED,
                dequeueAudit: {
                    ...reserved.dequeueAudit,
                    endTs: Temporal.Instant.fromEpochMilliseconds(1_100),
                },
            };
            return {
                reserved,
                current: mutateCurrent?.(completed) ?? completed,
            };
        },
    };
}

function createReservedSummaryEntry(): ResourceEntry {
    const work: GroupPresenceSummaryWorkData = {
        effectKind: 'group-presence-summary',
        aggregateRef: {
            applicationId: 'handler-finalized-app',
            workspaceId: 'main',
            groupId: 'handler-finalized-group',
        },
        commandId: 'handler-finalized-command',
        createdAtEpochMs: 1_000,
        expireAtEpochMs: 253_402_300_799_999,
        acceptedCausalRevision: {
            groupRevision: 3,
            presenceRevision: 2,
        },
        event: {
            applicationId: 'handler-finalized-app',
            workspaceId: 'main',
            groupId: 'handler-finalized-group',
            eventId: 'handler-finalized-event',
            eventType: 'session-connected',
            snapshotVersion: 3,
            causalRevision: {
                groupRevision: 3,
                presenceRevision: 2,
            },
            occurredAtEpochMs: 1_000,
            actor: { kind: 'service', serviceId: 'handler-test' },
            reason: null,
            traceId: null,
            requestId: 'handler-finalized-command',
            payload: {},
        },
    };
    const entry = computeGroupPresenceSummaryEntry(work, 'handler-test');
    return {
        ...entry,
        typeId: EnqueuedType.APP_OUTBOX,
        status: EntityStatus.RESERVED,
        dequeueAudit: {
            attempts: 4,
            startTs: Temporal.Instant.fromEpochMilliseconds(1_050),
        },
    };
}

function updateMessage(
    entry: ResourceEntry,
    update: (message: ALMessage) => ALMessage,
): ResourceEntry {
    const message = JSON.parse(entry.resource) as ALMessage;
    return { ...entry, resource: JSON.stringify(update(message)) };
}

function updateEnvelope(
    entry: ResourceEntry,
    update: (envelope: Record<string, unknown>) => Record<string, unknown>,
): ResourceEntry {
    return updateMessage(entry, (message) => {
        const envelope = JSON.parse(message.payload.resource) as Record<string, unknown>;
        return {
            ...message,
            payload: {
                ...message.payload,
                resource: JSON.stringify(update(envelope)),
            },
        };
    });
}
