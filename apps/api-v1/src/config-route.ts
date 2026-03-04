import {Hono} from "jsr:@hono/hono";
import {authorisedClients, configuration} from "./utils/config-repo.ts";
import {getKv, kvExpiryOptions, toClientKey, toClientsPrefix, toSessionKey} from "./utils/kv.ts";
import {ClientData, LoginRequest} from "@shared/api/api-config.ts";

export function init(app: Hono) {

    app.get(
        "/api/config",
        c => c.json(configuration)
    );

    app.post(
        "/api/client/:id",
        async c => {
            const id = c.req.param("id");
            const clientData = await c.req.json() as ClientData

            console.log(JSON.stringify(clientData))

            const kv = await getKv()

            await kv.set(toClientKey(id), clientData, kvExpiryOptions)
            await kv.set(toSessionKey(clientData.sessionId), clientData, kvExpiryOptions)

            return c.json(
                {
                    success: true
                }
            )
        }
    )

    app.post(
        "/api/auth/login",
        async c => {
            const loginRequest = await c.req.json() as LoginRequest;

            for (const client of authorisedClients) {
                if (client.username === loginRequest.username && client.password === loginRequest.password) {
                    return c.json({
                        clientId: client.clientId,
                        accessToken: crypto.randomUUID().substring(0, 10),
                        username: client.username,
                    })
                }
            }

            return c.json(
                {
                    error: "Invalid username or password"
                },
                401
            )
        }
    )

    app.get(
        "/api/read/clients",
        async c => {

            const db = await getKv();
            const entries = db.list(toClientsPrefix());

            const clients = [];
            for await (const entry of entries) {
                clients.push(entry.value as ClientData)
            }

            return c.json(clients)
        }
    )
}