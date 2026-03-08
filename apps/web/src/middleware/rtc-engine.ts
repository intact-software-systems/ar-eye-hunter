import { ClientData, IceConfig } from "@shared/api/api-config.ts";
import { InMemoryQueueBox } from "@shared/queuebox/InMemoryQueueBox.ts";
import { WebRtcQueueBoxClientService } from "@shared/services/WebRtcQueueBoxClientService.ts";
import { ResilienceDto } from "@shared/queuebox/DequeueResourceEntryController.ts";
import { InboxOutboxEngine } from "@shared/services/InboxOutboxEngine.ts";
import { WsRtcSignalingTransportUsingWsQBox } from "@shared/webrtc/WsRtcSignalingTransportUsingWsQBox.ts";
import { WsQueueBoxClientService } from "@shared/services/WsQueueBoxClientService.ts";

export async function initialise(
    qboxEngine: InboxOutboxEngine,
    webSocketQueueBox: WsQueueBoxClientService,
    typeId: string,
    clientData: ClientData,
    resilience: ResilienceDto,
    iceCandidates: IceConfig,
    dataChannelName: string,
    allTopicIds: Set<string>,
    rtcSignalingTopicId: string
) {
    const rtcQBox =
        await new WebRtcQueueBoxClientService(
            new InMemoryQueueBox(),
            new InMemoryQueueBox(),
            new WsRtcSignalingTransportUsingWsQBox(webSocketQueueBox, rtcSignalingTopicId),
            {
                sessionId: clientData.sessionId,
                token: "NOT_CREATED_YET",
                iceCandidates: iceCandidates,
                dataChannelName: dataChannelName,
                rtcSignalingTopicId: rtcSignalingTopicId,
            })
            .enableDefaultCallbacks()
            .connectSignaler();

    const outboxTypeId = typeId + "-outbox";

    qboxEngine.includeTask(
        outboxTypeId,
        {
            name: outboxTypeId,
            maxConcurrency: () => 1,
            isWork:
                () =>
                    rtcQBox
                        .outbox
                        .isAnyEntryToLock(
                            allTopicIds,
                            resilience.checkReserveTimeouts.isEntryRateLimiter,
                            resilience.checkFailed.isEntryRateLimiter
                        ),
            runnable:
                () => rtcQBox.dequeueOutbox(allTopicIds, resilience),
            ongoingTasks: [],
        }
    )

    const inboxTypeId = typeId + "-inbox";

    qboxEngine.includeTask(
        inboxTypeId,
        {
            name: inboxTypeId,
            maxConcurrency: () => 1,
            isWork:
                () =>
                    rtcQBox
                        .inbox
                        .isAnyEntryToLock(
                            allTopicIds,
                            resilience.checkReserveTimeouts.isEntryRateLimiter,
                            resilience.checkFailed.isEntryRateLimiter
                        ),
            runnable:
                () => rtcQBox.dequeueInbox(allTopicIds, resilience),
            ongoingTasks: [],
        }
    )

    return rtcQBox;
}

