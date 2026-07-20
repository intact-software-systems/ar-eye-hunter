import { describe, expect, it, vi } from 'vitest';
import { createApiV1RtcTopologyClusterTransport } from '../../../apps/api-v1/src/db/api-v1-rtc-topology-cluster-transport.ts';

describe('API-v1 RTC topology PostgreSQL cluster transport', () => {
    it('publishes small notifications and ignores notifications from this process', async () => {
        const notify = vi.fn().mockResolvedValue(undefined);
        let databaseListener: ((payload: string) => void | Promise<void>) | undefined;
        const transport = createApiV1RtcTopologyClusterTransport(
            { mode: 'postgres' },
            'publisher-a',
            {
                notify,
                listen: async (_channel, listener) => {
                    databaseListener = listener;
                },
            },
        );
        const notification = {
            v: 2 as const,
            publisherId: 'publisher-a',
            groupRef: {
                applicationId: 'app-1',
                workspaceId: 'workspace-1',
                groupId: 'room-1',
            },
            publicationId: 'work-1:4:2',
            sourceGroupStateCausalRevision: {
                groupRevision: 4,
                presenceRevision: 2,
            },
        };
        const receive = vi.fn();

        await transport.subscribe('topology-channel', receive);
        await transport.publish('topology-channel', notification);
        await databaseListener?.(JSON.stringify(notification));
        await databaseListener?.(JSON.stringify({
            ...notification,
            publisherId: 'publisher-b',
        }));
        await databaseListener?.(JSON.stringify({
            v: 1,
            publisherId: 'publisher-b',
            publicationId: 'legacy-work:4:2',
            sourceGroupStateRevision: 4,
        }));
        await databaseListener?.(JSON.stringify({
            v: 1,
            publisherId: 'publisher-b',
            groupRef: notification.groupRef,
            publicationId: 'legacy-work:4:2',
            sourceGroupStateRevision: 4,
        }));
        await databaseListener?.('{not-json');
        await databaseListener?.(JSON.stringify({
            v: 3,
            publisherId: 'publisher-b',
            publicationId: 'publication-2',
            sourceGroupStateRevision: 5,
        }));

        expect(notify).toHaveBeenCalledWith(
            'topology-channel',
            notification,
        );
        expect(receive).toHaveBeenCalledTimes(2);
        expect(receive).toHaveBeenNthCalledWith(1, {
            ...notification,
            publisherId: 'publisher-b',
        });
        expect(receive).toHaveBeenNthCalledWith(2, {
            v: 1,
            publisherId: 'publisher-b',
            publicationId: 'legacy-work:4:2',
            sourceGroupStateRevision: 4,
        });
    });
});
