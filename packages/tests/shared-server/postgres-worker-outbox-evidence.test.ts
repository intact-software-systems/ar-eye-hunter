import { AppTopics, EnqueuedType } from '@shared/api/api-config.ts';
import { GROUP_PRESENCE_SUMMARY_TOPIC } from '@shared/queuebox/GroupPresenceSummaryEntryContract.ts';
import { EntityStatus } from '@shared/queuebox/ResourceEntry.ts';
import { describe, expect, it } from 'vitest';
import { expectWorkerOutboxLifecycleEvidence } from './postgres-worker-outbox-evidence.ts';

describe('Postgres worker direct ResourceInbox evidence', () => {
    it('validates receipt-linked client WS and group APP lifecycle entries', () => {
        expect(() =>
            expectWorkerOutboxLifecycleEvidence(
                [
                    entry('client-snapshot', AppTopics.clientStateSnapshot, EnqueuedType.WS_OUTBOX, '{"id":"client-snapshot:principal-state:snapshot"}'),
                    entry('client-event', AppTopics.clientStateEvent, EnqueuedType.WS_OUTBOX, '{"id":"client-event:principal-state:event"}')
                ],
                [{ domainStatus: 'applied', outboxIds: ['client-snapshot', 'client-event'] }],
                'client',
                [
                    'principal-state:snapshot',
                    'principal-state:event'
                ]
            )
        ).not.toThrow();

        expect(() =>
            expectWorkerOutboxLifecycleEvidence(
                [
                    entry(
                        'group-summary',
                        GROUP_PRESENCE_SUMMARY_TOPIC,
                        EnqueuedType.APP_OUTBOX,
                        '{"id":"group-summary","payload":{"resource":"{\\"effectKind\\":\\"group-presence-summary\\"}"}}'
                    )
                ],
                [{ domainStatus: 'applied', outboxIds: ['group-summary'] }],
                'group',
                [
                    'group-presence-summary'
                ]
            )
        ).not.toThrow();
    });

    it('rejects an effect whose receipt-linked entry has the wrong direct outbox type', () => {
        expect(() =>
            expectWorkerOutboxLifecycleEvidence(
                [
                    entry('client-snapshot', AppTopics.clientStateSnapshot, EnqueuedType.APP_OUTBOX, '{"id":"client-snapshot:principal-state:snapshot"}'),
                    entry('client-event', AppTopics.clientStateEvent, EnqueuedType.WS_OUTBOX, '{"id":"client-event:principal-state:event"}')
                ],
                [{ domainStatus: 'applied', outboxIds: ['client-snapshot', 'client-event'] }],
                'client',
                [
                    'principal-state:snapshot',
                    'principal-state:event'
                ]
            )
        ).toThrow('Unexpected direct outbox type');
    });
});

function entry(
    resourceId: string,
    topicId: string,
    typeId: EnqueuedType,
    resource: string
) {
    return {
        resourceId,
        topicId,
        typeId,
        status: EntityStatus.NEW,
        resource
    };
}
