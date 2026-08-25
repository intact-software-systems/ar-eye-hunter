import type { RallarTimingSink } from '@shared-server/rallar-system/observability/timing.ts';
import type { InstallQueueBoxPubSubBridgeOptions } from '@shared-server/rallar-system/queue-pubsub/queue-box-pub-sub-bridge.ts';
import {
    isRtcTopologyPublicationOutboxEntry
} from '@shared-server/rallar-system/topology/replay/work/is-rtc-topology-publication-outbox-entry.ts';

import type { ApiV1DatabaseConfiguration } from '../../configuration/api-v1-configuration.ts';
import type { ApiV1DatabaseNotificationPort } from '../../db/api-v1-database-lifecycle.ts';
import {
    createApiV1QueuePubSubBridge,
    queuePubSubDeliveryForMode,
    shouldInstallQueuePubSubBridge
} from '../../db/api-v1-queue-pubsub-bridge.ts';

interface CreateApiRtcTopologyQueuePubSubBridgeInput {
    readonly mode: ApiV1DatabaseConfiguration['pubSub'];
    readonly notification: ApiV1DatabaseNotificationPort | null;
    readonly channel: string;
    readonly publisherId: string;
    readonly timing: RallarTimingSink;
    readonly wakeReplay: () => void;
}

type ApiRtcTopologyQueuePubSubBridgeOptions = Omit<InstallQueueBoxPubSubBridgeOptions, 'wsQBoxServerService'>;

export function createApiRtcTopologyQueuePubSubBridge(
    input: CreateApiRtcTopologyQueuePubSubBridgeInput
): ApiRtcTopologyQueuePubSubBridgeOptions | undefined {
    if (!shouldInstallQueuePubSubBridge(input.mode)) {
        return undefined;
    }
    return {
        bridge: createApiV1QueuePubSubBridge(
            input.mode,
            input.publisherId,
            input.notification
        ),
        channel: input.channel,
        publisherId: input.publisherId,
        delivery: queuePubSubDeliveryForMode(input.mode),
        timing: input.timing,
        onValidatedOutboxKeyReceived: (entry) => {
            if (isRtcTopologyPublicationOutboxEntry(entry)) {
                input.wakeReplay();
            }
        }
    };
}
