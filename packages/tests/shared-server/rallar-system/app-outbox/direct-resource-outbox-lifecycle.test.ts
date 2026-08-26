import { EnqueuedType } from '@shared/api/api-config.ts';
import { EntityStatus } from '@shared/queuebox/ResourceEntry.ts';
import { describe, expect, it } from 'vitest';
import { assertAppOutboxWsLink, assertDirectResourceOutboxEntries, assertDirectResourceOutboxLifecycle } from './direct-resource-outbox-lifecycle.ts';

describe('direct ResourceInbox outbox lifecycle', () => {
    it('requires exact APP_OUTBOX identity, topic, payload, and lifecycle', () => {
        expect(() =>
            assertDirectResourceOutboxEntries([{
                resourceId: 'command:topology',
                topicId: 'app-outbox.rtc-topology',
                typeId: EnqueuedType.APP_OUTBOX,
                status: EntityStatus.NEW,
                resource: '{"commandId":"command:topology"}'
            }], [{
                resourceId: 'command:topology',
                topicId: 'app-outbox.rtc-topology',
                typeId: EnqueuedType.APP_OUTBOX,
                status: EntityStatus.NEW,
                payloadIncludes: ['command:topology']
            }])
        ).not.toThrow();
        expect(() =>
            assertDirectResourceOutboxEntries([], [{
                resourceId: 'command:topology',
                topicId: 'app-outbox.rtc-topology',
                typeId: EnqueuedType.APP_OUTBOX,
                status: EntityStatus.NEW,
                payloadIncludes: ['command:topology']
            }])
        ).toThrow('Missing direct outbox entry');
    });

    it('requires a WS_OUTBOX payload to link its APP_OUTBOX resource identity', () => {
        expect(() =>
            assertAppOutboxWsLink({
                resourceId: 'app-work',
                topicId: 'app-outbox.rtc-topology',
                typeId: EnqueuedType.APP_OUTBOX,
                status: EntityStatus.NEW,
                resource: '{}'
            }, {
                resourceId: 'ws-work',
                topicId: 'ws-outbox.group-state',
                typeId: EnqueuedType.WS_OUTBOX,
                status: EntityStatus.NEW,
                resource: '{"source":"app-work"}'
            })
        ).not.toThrow();
    });

    it('checks APP-to-WS receipt linkage as part of a complete lifecycle', () => {
        expect(() =>
            assertDirectResourceOutboxLifecycle([{
                resourceId: 'app-work',
                topicId: 'app-outbox.rtc-topology',
                typeId: EnqueuedType.APP_OUTBOX,
                status: EntityStatus.NEW,
                resource: '{"commandId":"app-work"}'
            }, {
                resourceId: 'ws-work',
                topicId: 'ws-outbox.group-state',
                typeId: EnqueuedType.WS_OUTBOX,
                status: EntityStatus.NEW,
                resource: '{"source":"app-work"}'
            }], {
                entries: [{
                    resourceId: 'app-work',
                    topicId: 'app-outbox.rtc-topology',
                    typeId: EnqueuedType.APP_OUTBOX,
                    status: EntityStatus.NEW,
                    payloadIncludes: ['app-work']
                }, {
                    resourceId: 'ws-work',
                    topicId: 'ws-outbox.group-state',
                    typeId: EnqueuedType.WS_OUTBOX,
                    status: EntityStatus.NEW,
                    payloadIncludes: ['app-work']
                }],
                appToWsLinks: [{ appResourceId: 'app-work', wsResourceId: 'ws-work' }]
            })
        ).not.toThrow();
    });
});
