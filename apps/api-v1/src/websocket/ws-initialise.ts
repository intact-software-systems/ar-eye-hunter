import {WsQueueBoxInboxDto, WsQueueBoxServerService} from "@shared/services/WsQueueBoxServerService.ts";
import {PSqlQueueBox} from "../queuebox/PSqlQueueBox.ts";
import {JsonWebSocketServer} from "@shared/services/JsonWebSocketServer.ts";
import {qboxEngine as engine} from "../utils/qbox-engine.ts";
import {CircuitBreakerPolicy} from "@shared/resilience/Resilience.ts";
import {ResilienceDto} from "@shared/queuebox/DequeueResourceEntryController.ts";
import {ResourceEntry, toResourceEntryWithKey} from "@shared/queuebox/ResourceEntry.ts";
import * as dbNotify from "../repository/db-notify.ts";
import {myPublisherId, PublishMessage} from "../repository/db-notify.ts";
import * as dbListen from "../repository/db-listen.ts";

const NA = "NA";
const typeId = NA;
const wsChannelId = "ws-channel";

const types = new Set<string>([typeId])
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

export const wsQBoxServerService =
    new WsQueueBoxServerService(
        queueBox,
        queueBox,
        webSocketServer,
        {
            typeId: NA
        }
    )


wsQBoxServerService.onInboxMessageDo(
    typeId,
    {
        onMessage: async (value: WsQueueBoxInboxDto, entry: ResourceEntry, server: JsonWebSocketServer) => {
            server.broadcast(value.data);

            await dbNotify.notify(
                wsChannelId,
                {
                    key: entry.key,
                    channel: wsChannelId,
                    publisherId: myPublisherId,
                    typeId: entry.typeId,
                    payload: JSON.stringify(value.data)
                }
            );
        }
    }
)

dbListen.startListening(
        wsChannelId,
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


engine.includeTask(
    typeId,
    {
        name: typeId,
        maxConcurrency: () => 1,
        isWork:
            () =>
                wsQBoxServerService
                    .inbox
                    .isAnyEntryToLock(
                        types,
                        resilience.checkReserveTimeouts.isEntryRateLimiter,
                        resilience.checkFailed.isEntryRateLimiter
                    ),
        runnable:
            () => wsQBoxServerService.dequeueInboxToSend(resilience),
        ongoingTasks: [],
    }
)

