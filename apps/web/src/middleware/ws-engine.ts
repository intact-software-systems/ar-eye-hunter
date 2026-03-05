import {ClientData} from "@shared/api/api-config.ts";
import {ResilienceDto} from "@shared/queuebox/DequeueResourceEntryController.ts";
import {InMemoryQueueBox} from "@shared/queuebox/InMemoryQueueBox.ts";
import {WsQueueBoxClientService} from "@shared/services/WsQueueBoxClientService.ts";
import {JsonWebSocketClient} from "@shared/websocket/JsonWebSocketClient.ts";
import {InboxOutboxEngine} from "@shared/services/InboxOutboxEngine.ts";

export async function initialise(
    qboxEngine: InboxOutboxEngine,
    socket: JsonWebSocketClient,
    typeId: string,
    clientData: ClientData,
    resilience: ResilienceDto,
    allTopicIds: Set<string>,
) {
    const wsQueueBox =
        new WsQueueBoxClientService(
            new InMemoryQueueBox(),
            new InMemoryQueueBox(),
            socket,
            {
                sessionId: clientData.sessionId,
            }
        )
            .enableReconnect()
            .enableDefaultCallbacks();

    const outboxTypeId = typeId + "-outbox";

    qboxEngine.includeTask(
        outboxTypeId,
        {
            name: outboxTypeId,
            maxConcurrency: () => 1,
            isWork:
                () =>
                    wsQueueBox
                        .outbox
                        .isAnyEntryToLock(
                            allTopicIds,
                            resilience.checkReserveTimeouts.isEntryRateLimiter,
                            resilience.checkFailed.isEntryRateLimiter
                        ),
            runnable:
                () => wsQueueBox.dequeueOutbox(allTopicIds, resilience),
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
                    wsQueueBox
                        .inbox
                        .isAnyEntryToLock(
                            allTopicIds,
                            resilience.checkReserveTimeouts.isEntryRateLimiter,
                            resilience.checkFailed.isEntryRateLimiter
                        ),
            runnable:
                () => wsQueueBox.dequeueInbox(allTopicIds, resilience),
            ongoingTasks: [],
        }
    )

    await wsQueueBox.socket.connect();

    return wsQueueBox;
}
