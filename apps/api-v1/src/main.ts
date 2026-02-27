import {Hono} from "jsr:@hono/hono";
import {cors} from "jsr:@hono/hono/cors";

import {ChatTopicId, RtcSignalingTopicId} from "@shared/api/api-config.ts";
import {qboxEngine} from "./utils/qbox-engine.ts";
import {wsQBoxServerService} from "./websocket/ws-initialise.ts";

import * as chatTransport from "./websocket/ws-chat-transport.ts";
import * as rtcSignaling from "./websocket/ws-rtc-signaling.ts";

import * as iceRoutes from "./webrtc/ice_routes.ts";
import * as wsRelayer from "./websocket/ws-routes.ts";
import * as configRoutes from "./config-route.ts";

const app: Hono = new Hono();

app.use(
    "/api/*",
    cors(
        {
            origin: "http://localhost:5173", // Your SPA's address
            allowMethods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
            allowHeaders: ["Content-Type", "Authorization"],
            exposeHeaders: ["Content-Length"],
            maxAge: 600, // Cache the preflight for 10 minutes
            credentials: true,
        }
    )
);

chatTransport.initChatTransport(ChatTopicId, wsQBoxServerService)
rtcSignaling.initWsRtcSignaling(RtcSignalingTopicId, wsQBoxServerService)

configRoutes.init(app)
wsRelayer.init(app)
iceRoutes.init(app)

qboxEngine.start()

Deno.serve({port: 8080}, app.fetch)
console.log("Server started on port 8080");

