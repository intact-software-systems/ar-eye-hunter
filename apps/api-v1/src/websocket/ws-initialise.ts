import {allTopicIds} from "@shared/api/api-config.ts";
import {ResilienceDto} from "@shared/queuebox/DequeueResourceEntryController.ts";
import {ResourceEntry, toResourceEntryWithKey} from "@shared/queuebox/ResourceEntry.ts";
import {CircuitBreakerPolicy} from "@shared/resilience/Resilience.ts";
import {WsQueueBoxServerService} from "@shared/services/WsQueueBoxServerService.ts";
import {JsonWebSocketServer} from "@shared/websocket/JsonWebSocketServer.ts";
import {PSqlQueueBox} from "../queuebox/PSqlQueueBox.ts";
import * as dbListen from "../repository/db-listen.ts";
import * as dbNotify from "../repository/db-notify.ts";
import {myPublisherId, PublishMessage} from "../repository/db-notify.ts";
import {qboxEngine as engine} from "../utils/qbox-engine.ts";

const dbWsChannelId = "ws-channel";

const duration = Temporal.Duration.from({seconds: 10});
const slidingWindowDuration = Temporal.Duration.from({minutes: 10});
const initialRate = 1;
const maxRate = 10;
const concurrencyIncreaseStep = 1;
const concurrencyReduceStep = 1;

const circuitBreakerPolicy =
    new CircuitBreakerPolicy(
        10,
        duration,
        duration,
        slidingWindowDuration
    )

const resilience =
    ResilienceDto.toResilienceDto(
        circuitBreakerPolicy,
        initialRate,
        maxRate,
        concurrencyIncreaseStep,
        concurrencyReduceStep
    );


const queueBox = new PSqlQueueBox();
const webSocketServer = new JsonWebSocketServer();

export const wsQBoxServerService: WsQueueBoxServerService =
    new WsQueueBoxServerService(
        queueBox,
        queueBox,
        webSocketServer,
        "default-qbox-server"
    )

wsQBoxServerService.onAllInboxMessagesDo(
    {
        onMessage: async (_, entry: ResourceEntry, __) => {
            await dbNotify.notify(
                dbWsChannelId,
                {
                    key: entry.key,
                    channel: dbWsChannelId,
                    publisherId: myPublisherId,
                    typeId: entry.typeId,
                    payload: entry.resource
                }
            );
        }
    }
)

wsQBoxServerService.onAllOutboxMessagesDo(
    {
        onMessage: async (_, entry: ResourceEntry, __) => {
            await dbNotify.notify(
                dbWsChannelId,
                {
                    key: entry.key,
                    channel: dbWsChannelId,
                    publisherId: myPublisherId,
                    typeId: entry.typeId,
                    payload: entry.resource
                }
            );
        }
    }
)

dbListen.startListening(
        dbWsChannelId,
        async (message: PublishMessage) => {
            console.log(`Received message: ${message}`);

            await wsQBoxServerService.inbox.enqueue(
                toResourceEntryWithKey(
                    message.key,
                    message.typeId,
                    message.payload
                )
            )
        }
    )
    .finally(() => {
        // is it finished if it reaches here?
    })


const wsInboxId = "ws-inbox";

engine.includeTask(
    wsInboxId,
    {
        name: wsInboxId,
        maxConcurrency: () => 1,
        isWork:
            () =>
                wsQBoxServerService
                    .inbox
                    .isAnyEntryToLock(
                        allTopicIds,
                        resilience.checkReserveTimeouts.isEntryRateLimiter,
                        resilience.checkFailed.isEntryRateLimiter
                    ),
        runnable:
            () => wsQBoxServerService.dequeueInbox(allTopicIds, resilience),
        ongoingTasks: [],
    }
)

const wsOutboxId = "ws-outbox";

engine.includeTask(
    wsOutboxId,
    {
        name: wsOutboxId,
        maxConcurrency: () => 1,
        isWork:
            () =>
                wsQBoxServerService
                    .outbox
                    .isAnyEntryToLock(
                        allTopicIds,
                        resilience.checkReserveTimeouts.isEntryRateLimiter,
                        resilience.checkFailed.isEntryRateLimiter
                    ),
        runnable:
            () => wsQBoxServerService.dequeueOutbox(allTopicIds, resilience),
        ongoingTasks: [],
    }
)


