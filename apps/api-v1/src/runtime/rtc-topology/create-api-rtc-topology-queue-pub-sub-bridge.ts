import type {
  InstallQueueBoxPubSubBridgeOptions,
} from '@shared-server/rallar-system/pubsub/QueueBoxPubSubBridge.ts';
import type { RallarTimingSink } from '@shared-server/rallar-system/services/timing.ts';
import {
  isRtcTopologyPublicationOutboxEntry,
} from '@shared-server/rallar-system/topology/replay/is-rtc-topology-publication-outbox-entry.ts';

import {
  createApiV1QueuePubSubBridge,
  queuePubSubDeliveryForConfig,
  shouldInstallQueuePubSubBridge,
} from '../../db/api-v1-queue-pubsub-bridge.ts';
import type { ApiV1DatabasePubSubConfig } from '../../db/database-pubsub-config.ts';

interface CreateApiRtcTopologyQueuePubSubBridgeInput {
  readonly config: ApiV1DatabasePubSubConfig;
  readonly channel: string;
  readonly publisherId: string;
  readonly timing: RallarTimingSink;
  readonly wakeReplay: () => void;
}

type ApiRtcTopologyQueuePubSubBridgeOptions = Omit<
  InstallQueueBoxPubSubBridgeOptions,
  'wsQBoxServerService'
>;

export function createApiRtcTopologyQueuePubSubBridge(
  input: CreateApiRtcTopologyQueuePubSubBridgeInput,
): ApiRtcTopologyQueuePubSubBridgeOptions | undefined {
  if (!shouldInstallQueuePubSubBridge(input.config)) return undefined;
  return {
    bridge: createApiV1QueuePubSubBridge(input.config, input.publisherId),
    channel: input.channel,
    publisherId: input.publisherId,
    delivery: queuePubSubDeliveryForConfig(input.config),
    timing: input.timing,
    onValidatedOutboxKeyReceived: (entry) => {
      if (isRtcTopologyPublicationOutboxEntry(entry)) input.wakeReplay();
    },
  };
}
