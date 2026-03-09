import "jsr:@std/dotenv/load";
import { Hono } from "jsr:@hono/hono";
import { cors } from "jsr:@hono/hono/cors";

import { AppTopics } from "@shared/api/api-config.ts";
import { qboxEngine } from "./utils/qbox-engine.ts";
import { wsQBoxServerService } from "./websocket/ws-initialise.ts";

import * as clientTransport from "./websocket/ws-client-transport.ts";
import * as roomTransport from "./websocket/ws-rooms-transport.ts";
import * as chatTransport from "./websocket/ws-chat-transport.ts";
import * as rtcSignaling from "./websocket/ws-rtc-signaling.ts";

import * as configRoutes from "./config-route.ts";
import * as wsRoutes from "./websocket/ws-routes.ts";
import * as iceRoutes from "./webrtc/ice-route.ts";
import * as roomRoutes from "./rooms/room-routes.ts";
import * as heartbeat from "./heartbeat.ts";

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

clientTransport.initClientTransport(AppTopics.client, wsQBoxServerService)
roomTransport.initRoomTransport(AppTopics.rooms, wsQBoxServerService)
chatTransport.initChatTransport(AppTopics.chat, wsQBoxServerService)
rtcSignaling.initWsRtcSignaling(AppTopics.rtcSignaling, wsQBoxServerService)

heartbeat.initHeartbeat(wsQBoxServerService)
    .catch(e => console.error("Failed to initialise heartbeat:", e))

configRoutes.init(app)
wsRoutes.init(app)
iceRoutes.init(app)
roomRoutes.init(app)

qboxEngine.start()

Deno.serve({port: 8080}, app.fetch)
console.log("Server started on port 8080");
