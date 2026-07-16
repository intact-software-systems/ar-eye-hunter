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
            v: 1 as const,
            publisherId: 'publisher-a',
            publicationId: 'publication-1',
            sourceGroupStateRevision: 4,
        };
        const receive = vi.fn();

        await transport.subscribe('topology-channel', receive);
        await transport.publish('topology-channel', notification);
        await databaseListener?.(JSON.stringify(notification));
        await databaseListener?.(JSON.stringify({
            ...notification,
            publisherId: 'publisher-b',
        }));
        await databaseListener?.('{not-json');
        await databaseListener?.(JSON.stringify({
            v: 2,
            publisherId: 'publisher-b',
            publicationId: 'publication-2',
            sourceGroupStateRevision: 5,
        }));

        expect(notify).toHaveBeenCalledWith(
            'topology-channel',
            notification,
        );
        expect(receive).toHaveBeenCalledTimes(1);
        expect(receive).toHaveBeenCalledWith({
            ...notification,
            publisherId: 'publisher-b',
        });
    });
});
