import {allTopicIds, ApiConfig, IceConfig, rtcSignalingTopicId} from "@shared/api/api-config.ts";
import {InboxOutboxEngine} from "@shared/services/InboxOutboxEngine.ts";
import {WebRtcQueueBoxClientService} from "@shared/services/WebRtcQueueBoxClientService.ts";
import {WsQueueBoxClientService} from "@shared/services/WsQueueBoxClientService.ts";
import {JsonWebSocketClient} from "@shared/websocket/JsonWebSocketClient.ts";
import {readApiConfig, readIceCandidates} from "./api-integration.ts";
import {appClientData, toResilienceDto} from "./config.ts";
import * as cache from "./data-caches.ts";
import * as qbox from "./qbox-engine.ts";
import * as rtcEngine from "./rtc-engine.ts";
import * as wsEngine from "./ws-engine.ts";
import * as wsMessageRouter from "./ws-message-router.ts";

export const apiConfig: ApiConfig = await readApiConfig();

function toCreateWsUrl(id: string) {
    return apiConfig.wsBaseUrl + apiConfig.endpoints.createWs.replace(":id", id);
}

const wsJsonSocketClient: JsonWebSocketClient =
    new JsonWebSocketClient(toCreateWsUrl(appClientData.clientId));

const qboxEngine: InboxOutboxEngine = qbox.initialise();

const webSocketQueueBox: WsQueueBoxClientService =
    await wsEngine.initialise(
        qboxEngine,
        wsJsonSocketClient,
        "WS",
        appClientData,
        toResilienceDto(),
        allTopicIds
    );

wsMessageRouter.initialise(webSocketQueueBox);

const iceCandidates: IceConfig = await readIceCandidates();

const webRtcQueueBox: WebRtcQueueBoxClientService =
    rtcEngine.initialise(
        qboxEngine,
        wsJsonSocketClient,
        "RTC",
        appClientData,
        toResilienceDto(),
        iceCandidates,
        "rtc-data-channel",
        allTopicIds,
        rtcSignalingTopicId
    );

await cache.initialise(
    webSocketQueueBox,
    webRtcQueueBox,
    appClientData
)

export type Middleware = {
    qboxEngine: InboxOutboxEngine,
    webSocketQueueBox: WsQueueBoxClientService,
    webRtcQueueBox: WebRtcQueueBoxClientService,
}

export const middleware: Middleware = {
    qboxEngine: qboxEngine,
    webSocketQueueBox: webSocketQueueBox,
    webRtcQueueBox: webRtcQueueBox,
}