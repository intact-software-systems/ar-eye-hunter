import {
    createDisabledRtcTopologyClusterTransport,
    createLocalRtcTopologyClusterTransport,
    isRtcTopologyPublicationNotification,
    type RtcTopologyClusterTransport
} from '@shared-server/rallar-system/pubsub/RtcTopologyClusterTransport.ts';
import type { ApiV1DatabasePubSubConfig } from './database-pubsub-config.ts';
import { getListenSql } from './db-listen.ts';
import * as dbNotify from './db-notify.ts';

export type ApiV1RtcTopologyClusterTransportDependencies = Readonly<{
    notify(channel: string, notification: unknown): Promise<void>;
    listen(
        channel: string,
        listener: (payload: string) => void | Promise<void>
    ): Promise<unknown>;
}>;

export function createApiV1RtcTopologyClusterTransport(
    config: ApiV1DatabasePubSubConfig,
    publisherId: string,
    dependencies: ApiV1RtcTopologyClusterTransportDependencies = {
        notify: dbNotify.notify,
        listen: async (channel, listener) => await getListenSql().listen(channel, listener)
    }
): RtcTopologyClusterTransport {
    switch (config.mode) {
        case 'local':
            return createLocalRtcTopologyClusterTransport();
        case 'disabled':
            return createDisabledRtcTopologyClusterTransport();
        case 'postgres':
            return {
                publish: async (channel, notification) => {
                    await dependencies.notify(channel, notification);
                },
                subscribe: async (channel, listener) => {
                    await dependencies.listen(
                        channel,
                        async (payload: string) => {
                            let notification: unknown;
                            try {
                                notification = JSON.parse(payload);
                            }
                            catch {
                                return;
                            }
                            if (
                                isRtcTopologyPublicationNotification(notification) &&
                                notification.publisherId !== publisherId
                            ) {
                                await listener(notification);
                            }
                        }
                    );
                }
            };
    }
}
