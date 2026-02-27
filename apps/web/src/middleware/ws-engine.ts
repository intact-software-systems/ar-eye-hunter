import {WsQueueBoxClientService} from "@shared/services/WsQueueBoxClientService.ts";
import {InMemoryQueueBox} from "@shared/queuebox/InMemoryQueueBox.ts";
import {JsonWebSocketClient} from "@shared/websocket/JsonWebSocketClient.ts";
import {qboxEngine} from "./qbox-engine.ts";
import {appClientData, toResilienceDto} from "./config.ts";
import {toCreateWsEndpoint} from "./data-caches.ts";
import {allTopicIds} from "@shared/api/api-config.ts";

const resilience = toResilienceDto();

const typeId = "WS";

export const webSocketQueueBox = await initialise(typeId, appClientData.clientId);

async function initialise(typeId: string, clientId: string) {

    console.log(`WebSocket client ID: ${(clientId)}`);

    const wsQueueBox =
        new WsQueueBoxClientService(
            new InMemoryQueueBox(),
            new InMemoryQueueBox(),
            new JsonWebSocketClient(toCreateWsEndpoint(clientId)),
            {
                clientId: clientId,
            }
        )
            .enableReconnect()
            .enableDefaultCallbacks();

    includeToEngine(typeId, wsQueueBox);

    await wsQueueBox.socket.connect();

    return wsQueueBox;
}

export function includeToEngine(
    typeId: string,
    wsQueueBox: WsQueueBoxClientService
) {

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

    return wsQueueBox
}
