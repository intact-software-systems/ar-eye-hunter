import {WsQueueBoxClientService} from "@shared/services/WsQueueBoxClientService.ts";
import {InMemoryQueueBox} from "@shared/queuebox/InMemoryQueueBox.ts";
import {JsonWebSocketClient} from "@shared/websocket/JsonWebSocketClient.ts";
import {qboxEngine} from "./qbox-engine.ts";
import {toCreateWsEndpoint, toResilienceDto} from "../utils/config.ts";

const resilience = toResilienceDto();

const typeId = "WS";

export const webSocketClientId = crypto.randomUUID().toString();

export const webSocketQueueBox = await initialise(typeId, webSocketClientId);

async function initialise(typeId: string, clientId: string) {

    console.log(`WebSocket client ID: ${webSocketClientId}`);

    const wsQueueBox =
        new WsQueueBoxClientService(
            new InMemoryQueueBox(),
            new InMemoryQueueBox(),
            new JsonWebSocketClient(toCreateWsEndpoint(clientId)),
            {
                inboxTypeId: typeId,
                outboxTypeId: typeId
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

    const inboxTypeId = typeId + "-inbox";
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
                            wsQueueBox.outboxTypesToDequeue,
                            resilience.checkReserveTimeouts.isEntryRateLimiter,
                            resilience.checkFailed.isEntryRateLimiter
                        ),
            runnable:
                () => wsQueueBox.dequeueOutbox(resilience),
            ongoingTasks: [],
        }
    )

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
                            wsQueueBox.inboxTypesToDequeue,
                            resilience.checkReserveTimeouts.isEntryRateLimiter,
                            resilience.checkFailed.isEntryRateLimiter
                        ),
            runnable:
                () => wsQueueBox.dequeueInbox(resilience),
            ongoingTasks: [],
        }
    )

    return wsQueueBox
}
