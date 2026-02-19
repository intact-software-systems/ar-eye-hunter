import {ConnectionContext} from "@shared/services/JsonWebSocketServer.ts";
import {Hono} from "jsr:@hono/hono";
import {wsQBoxServerService} from "./ws-initialise.ts";

export function initialise(app: Hono): void {
    app.get(
        "/api/ws/:id",
        c => {
            if (c.req.header("upgrade") !== "websocket") {
                return c.text("Expected Upgrade: websocket", 426);
            }

            try {
                const {socket, response} = Deno.upgradeWebSocket(c.req.raw);

                const id = c.req.param("id");

                wsQBoxServerService.socket.addConnection(new ConnectionContext(id, socket))

                console.log(`Upgrading connection for ID: ${id}`);

                return response;
            } catch (err) {
                console.error(err);
                return c.text("WebSocket upgrade failed", 500);
            }
        }
    );
}




