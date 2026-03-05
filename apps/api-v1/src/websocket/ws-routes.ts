import {Hono} from "jsr:@hono/hono";
import * as clientTransport from "./ws-client-transport.ts";

export function init(app: Hono): void {
    app.get(
        "/api/ws/:sessionId",
        async c => {
            if (c.req.header("upgrade") !== "websocket") {
                return c.text("Expected Upgrade: websocket", 426);
            }

            try {
                const {socket, response} = Deno.upgradeWebSocket(c.req.raw);

                const sessionId = c.req.param("sessionId");

                await clientTransport.addWsAndPublishClient(sessionId, socket);

                console.log(`Upgrading connection for ID: ${sessionId}`);

                return response;
            } catch (err) {
                console.error(err);
                return c.text("WebSocket upgrade failed", 500);
            }
        }
    );
}




