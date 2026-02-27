import {describe, expect, it} from "vitest";
import {ResilienceDto} from "@shared/queuebox/DequeueResourceEntryController.ts";
import {InMemoryQueueBox} from "@shared/queuebox/InMemoryQueueBox.ts";
import {CircuitBreakerPolicy} from "@shared/resilience/Resilience.ts";
import {InboxOutboxEngine} from "@shared/services/InboxOutboxEngine.ts";
import {WsQueueBoxClientService} from "@shared/services/WsQueueBoxClientService.ts";
import {JsonWebSocketClient} from "../shared/websocket/JsonWebSocketClient.ts";
import {QueueBoxUtilities} from "../shared/services/QueueBoxUtilities.ts";

describe("engine", () => {

    it('', async () => {

        // const abortController = new AbortController();

        // // 1. Start the Server
        // const server =
        //     Deno.serve({
        //         port: 8080,
        //         signal: abortController.signal
        //     }, (req) => {
        //         if (req.headers.get("upgrade") !== "websocket") {
        //             return new Response(null, {status: 426});
        //         }
        //         const {socket, response} = Deno.upgradeWebSocket(req);
        //         socket.onmessage = (e) => socket.send(`Echo: ${e.data}`);
        //         return response;
        //     });

        const typeId = "WHACK";
        const types = new Set<string>([typeId])
        const duration = Temporal.Duration.from({seconds: 10});
        const initialRate = 1;
        const maxRate = 10;
        const concurrencyIncreaseStep = 1;
        const concurrencyReduceStep = 1;

        const circuitBreakerPolicy =
            new CircuitBreakerPolicy(
                10,
                duration,
                duration,
                duration
            )

        const resilience =
            ResilienceDto.toResilienceDto(
                circuitBreakerPolicy,
                initialRate,
                maxRate,
                concurrencyIncreaseStep,
                concurrencyReduceStep
            );


        const wsQueueBox =
            new WsQueueBoxClientService(
                new InMemoryQueueBox(),
                new InMemoryQueueBox(),
                new JsonWebSocketClient("ws://localhost:8000/api/ws/testClientId"),
                {
                    inboxTypeId: typeId,
                    outboxTypeId: typeId
                })
                .enableReconnect();

        wsQueueBox
            .onOutboxMessageDo(
                typeId,
                {
                    onMessage: async (entry, socket) => {
                        console.log(entry.resource);
                        socket.send(entry.resource);
                    }
                }
            )

        wsQueueBox.socket
            .onWebSocketMessageDo(
                typeId,
                {
                    onMessage: async data => {
                        console.log(data);
                    }
                }
            )
            .onWebSocketMessageDo(
                "enqueue" + typeId,
                {
                    onMessage: async data => {
                        await wsQueueBox.inbox.enqueue(QueueBoxUtilities.toResourceEntry(typeId, data));
                    }
                }
            )


        try {
            await wsQueueBox.socket.connect();
        } catch (error) {
            console.error(error);
        }

        const engine = new InboxOutboxEngine()

        engine.includeTask(
            typeId,
            {
                name: typeId,
                maxConcurrency: () => 1,
                isWork:
                    () =>
                        wsQueueBox
                            .outbox
                            .isAnyEntryToLock(
                                types,
                                resilience.checkReserveTimeouts.isEntryRateLimiter,
                                resilience.checkFailed.isEntryRateLimiter
                            ),
                runnable:
                    () => wsQueueBox.dequeueOutbox(resilience),
                ongoingTasks: [],
            }
        )

        const helloWorld = "hello world";

        class TestData {
            constructor(
                readonly name: string,
            ) {
            }
        }

        await wsQueueBox.outbox.enqueue(QueueBoxUtilities.toResourceEntry(typeId, new TestData(helloWorld)))

        const isSuccess = await engine.executeOnce();


        expect(isSuccess).toBe(true);

        // abortController.abort();
    })
})