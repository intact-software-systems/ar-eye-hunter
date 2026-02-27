import {ConnectionContext} from "@shared/websocket/JsonWebSocketServer.ts";
import {Hono} from "jsr:@hono/hono";
import {wsQBoxServerService} from "./ws-initialise.ts";
import {toALMessage} from "@shared/al-contracts/al-contract.ts";
import {ClientData, ClientTopicId} from "@shared/api/api-config.ts";

export function init(app: Hono): void {
    app.get(
        "/api/ws/:id",
        async c => {
            if (c.req.header("upgrade") !== "websocket") {
                return c.text("Expected Upgrade: websocket", 426);
            }

            try {
                const {socket, response} = Deno.upgradeWebSocket(c.req.raw);

                const id = c.req.param("id");

                wsQBoxServerService.socket.addConnection(new ConnectionContext(id, socket))

                await wsQBoxServerService.enqueueOutboxIfAbsent(
                    toALMessage<ClientData>(
                        id,
                        ClientTopicId,
                        {
                            clientId: id,
                            sessionId: id
                        }
                    )
                )

                console.log(`Upgrading connection for ID: ${id}`);

                return response;
            } catch (err) {
                console.error(err);
                return c.text("WebSocket upgrade failed", 500);
            }
        }
    );
}




