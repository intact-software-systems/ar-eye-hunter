import {ApiConfig, ClientData, IceConfig} from "@shared/api/api-config.ts";
import {InboxOutboxEngine} from "@shared/services/InboxOutboxEngine.ts";
import {WebRtcQueueBoxClientService} from "@shared/services/WebRtcQueueBoxClientService.ts";
import {WsQueueBoxClientService} from "@shared/services/WsQueueBoxClientService.ts";
import {JsonWebSocketClient} from "@shared/websocket/JsonWebSocketClient.ts";
import {readApiConfig, readIceCandidates} from "./api-integration.ts";
import {toResilienceDto} from "./config.ts";
import * as cache from "./data-caches.ts";
import * as qbox from "./qbox-engine.ts";
import * as rtcEngine from "./rtc-engine.ts";
import * as wsEngine from "./ws-engine.ts";
import * as wsMessageRouter from "./ws-message-router.ts";
import * as rtcMessageRouter from "./rtc-message-router.ts";

export const apiConfig: ApiConfig = await readApiConfig();

function toCreateWsUrl(id: string) {
    return apiConfig.wsBaseUrl + apiConfig.endpoints.createWs.replace(":id", id);
}

export type Middleware = {
    qboxEngine: InboxOutboxEngine,
    webSocketQueueBox: WsQueueBoxClientService,
    webRtcQueueBox: WebRtcQueueBoxClientService,
}

export async function initialise(
    clientData: ClientData,
    rtcSignalingTopicId: string,
    topicIds: Set<string>
): Promise<Middleware> {

    const socket = new JsonWebSocketClient(toCreateWsUrl(clientData.clientId));

    await socket.connect()
        .catch((error) => {
            console.error("Failed to connect WebSocket client:", error);
            throw error;
        });

    const qboxEngine: InboxOutboxEngine = qbox.initialise();

    const webSocketQueueBox: WsQueueBoxClientService =
        await wsEngine.initialise(
            qboxEngine,
            socket,
            "WS",
            clientData,
            toResilienceDto(),
            topicIds
        );

    wsMessageRouter.initialise(webSocketQueueBox);

    const iceCandidates: IceConfig = await readIceCandidates();

    const webRtcQueueBox: WebRtcQueueBoxClientService =
        rtcEngine.initialise(
            qboxEngine,
            socket,
            "RTC",
            clientData,
            toResilienceDto(),
            iceCandidates,
            "rtc-data-channel",
            topicIds,
            rtcSignalingTopicId
        );

    rtcMessageRouter.initialise(webRtcQueueBox);

    await cache.initialise(
        webSocketQueueBox,
        webRtcQueueBox,
        clientData
    )

    return {
        qboxEngine: qboxEngine,
        webSocketQueueBox: webSocketQueueBox,
        webRtcQueueBox: webRtcQueueBox,
    }
}
