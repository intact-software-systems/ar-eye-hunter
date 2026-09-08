import type { ALMessage } from '@shared/al-contracts/al-contract.ts';
import { AppTopics, type RttMeasurementInfo } from '@shared/api/api-config.ts';
import type { ResourceEntry } from '@shared/queuebox/ResourceEntry.ts';
import type { WsQueueBoxServerService } from '@shared/services/ws-queue-box-server/ws-queue-box-server-service.ts';

import { decodeJsonWireValue } from '../../protocol/json-wire-identity.ts';
import { validateRtcRttMeasurement } from '../persistence/rtc-rtt-persistence-validation.ts';

export interface RtcRttTopicMutationInput {
    readonly rtt: RttMeasurementInfo;
    readonly alSenderId: string;
    readonly capturedAtEpochMs: number;
}

export interface InstallRtcRttSystemTopicOptions {
    enqueueMutation(
        input: RtcRttTopicMutationInput
    ): Promise<ResourceEntry>;
}

export function installRtcRttSystemTopic(
    wsService: WsQueueBoxServerService,
    options: InstallRtcRttSystemTopicOptions
): void {
    wsService.onInboxMessageDo(AppTopics.rtt, {
        onMessage: async (
            message: ALMessage
        ) => {
            if (message.route.topicId !== AppTopics.rtt) {
                return;
            }
            const rtt = decodeJsonWireValue(
                JSON.parse(message.payload.resource),
                'RTC RTT measurement'
            );
            validateRtcRttMeasurement(rtt);

            await options.enqueueMutation({
                rtt,
                alSenderId: message.id.senderId,
                capturedAtEpochMs: Date.now()
            });
        }
    });
}
