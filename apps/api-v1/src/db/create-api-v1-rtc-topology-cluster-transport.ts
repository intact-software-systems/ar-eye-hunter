import {
    createDisabledRtcTopologyClusterTransport,
    createLocalRtcTopologyClusterTransport,
    isRtcTopologyPublicationNotification,
    type RtcTopologyClusterTransport
} from '@shared-server/rallar-system/pubsub/RtcTopologyClusterTransport.ts';
import type { ApiV1DatabaseConfiguration } from '../configuration/api-v1-configuration.ts';
import type { ApiV1DatabaseNotificationPort } from './api-v1-database-lifecycle.ts';

export function createApiV1RtcTopologyClusterTransport(
    mode: ApiV1DatabaseConfiguration['pubSub'],
    publisherId: string,
    notification: ApiV1DatabaseNotificationPort | null
): RtcTopologyClusterTransport {
    switch (mode) {
        case 'local':
            return createLocalRtcTopologyClusterTransport();
        case 'disabled':
            return createDisabledRtcTopologyClusterTransport();
        case 'postgres':
            if (notification === null) {
                throw new TypeError('PostgreSQL topology transport requires the database notification port.');
            }
            return {
                publish: async (channel, message) => {
                    await notification.notify(channel, message);
                },
                subscribe: async (channel, listener) => {
                    await notification.listen(
                        channel,
                        async (payload: string) => {
                            let parsedNotification: object | string | number | boolean | null;
                            try {
                                parsedNotification = JSON.parse(payload);
                            }
                            catch {
                                return;
                            }
                            if (
                                isRtcTopologyPublicationNotification(parsedNotification) &&
                                parsedNotification.publisherId !== publisherId
                            ) {
                                await listener(parsedNotification);
                            }
                        }
                    );
                }
            };
    }
}
