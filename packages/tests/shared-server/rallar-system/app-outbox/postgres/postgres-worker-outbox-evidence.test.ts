import { AppTopics, EnqueuedType } from '@shared/api/api-config.ts';
import { GROUP_PRESENCE_SUMMARY_TOPIC } from '@shared/queuebox/GroupPresenceSummaryEntryContract.ts';
import { EntityStatus } from '@shared/queuebox/ResourceEntry.ts';
import { describe, expect, it } from 'vitest';
import { expectWorkerOutboxLifecycleEvidence } from './postgres-worker-outbox-evidence.ts';

describe('Postgres worker direct ResourceInbox evidence', () => {
    it('validates receipt-linked client WS and group APP lifecycle entries', () => {
        expect(() =>
            expectWorkerOutboxLifecycleEvidence({
                entries: [
                    entry({
                        resourceId: 'client-snapshot',
                        topicId: AppTopics.clientStateSnapshot,
                        typeId: EnqueuedType.WS_OUTBOX,
                        resource: '{"id":"client-snapshot:principal-state:snapshot"}'
                    }),
                    entry({
                        resourceId: 'client-event',
                        topicId: AppTopics.clientStateEvent,
                        typeId: EnqueuedType.WS_OUTBOX,
                        resource: '{"id":"client-event:principal-state:event"}'
                    })
                ],
                outputs: [{ domainStatus: 'applied', outboxIds: ['client-snapshot', 'client-event'] }],
                kind: 'client',
                effects: [
                    'principal-state:snapshot',
                    'principal-state:event'
                ]
            })
        ).not.toThrow();

        expect(() =>
            expectWorkerOutboxLifecycleEvidence({
                entries: [
                    entry({
                        resourceId: 'group-summary',
                        topicId: GROUP_PRESENCE_SUMMARY_TOPIC,
                        typeId: EnqueuedType.APP_OUTBOX,
                        resource: '{"id":"group-summary","payload":{"resource":"{\\"effectKind\\":\\"group-presence-summary\\"}"}}'
                    })
                ],
                outputs: [{ domainStatus: 'applied', outboxIds: ['group-summary'] }],
                kind: 'group',
                effects: [
                    'group-presence-summary'
                ]
            })
        ).not.toThrow();
    });

    it('rejects an effect whose receipt-linked entry has the wrong direct outbox type', () => {
        expect(() =>
            expectWorkerOutboxLifecycleEvidence({
                entries: [
                    entry({
                        resourceId: 'client-snapshot',
                        topicId: AppTopics.clientStateSnapshot,
                        typeId: EnqueuedType.APP_OUTBOX,
                        resource: '{"id":"client-snapshot:principal-state:snapshot"}'
                    }),
                    entry({
                        resourceId: 'client-event',
                        topicId: AppTopics.clientStateEvent,
                        typeId: EnqueuedType.WS_OUTBOX,
                        resource: '{"id":"client-event:principal-state:event"}'
                    })
                ],
                outputs: [{ domainStatus: 'applied', outboxIds: ['client-snapshot', 'client-event'] }],
                kind: 'client',
                effects: [
                    'principal-state:snapshot',
                    'principal-state:event'
                ]
            })
        ).toThrow('Unexpected direct outbox type');
    });
});

interface EntryInput {
    readonly resourceId: string;
    readonly topicId: string;
    readonly typeId: EnqueuedType;
    readonly resource: string;
}

function entry(input: EntryInput) {
    const { resourceId, topicId, typeId, resource } = input;
    return {
        resourceId,
        topicId,
        typeId,
        status: EntityStatus.NEW,
        resource
    };
}
