import {Hono} from "jsr:@hono/hono";
import {ClientData, LoginRequest} from "@shared/api/api-config.ts";
import {configuration} from "./utils/config-repo.ts";
import {getKv, kvExpiryOptions, toClientKey, toClientsPrefix, toSessionKey} from "./utils/kv.ts";
import * as loginRepository from "./clients/client-repository.ts";
import {mockedClients} from "./clients/client-repository.ts";

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

            const loginResponse = loginRepository.login(loginRequest)

            return loginResponse
                ?
                c.json(loginResponse)
                :
                c.json(
                    {
                        error: "Invalid username or password"
                    },
                    401
                );

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

    app.get(
        "/api/read/mock/clients",
        async c => {
            return c.json(mockedClients())
        }
    )
}