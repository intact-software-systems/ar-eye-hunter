import {Hono} from "jsr:@hono/hono";
import {configuration} from "./utils/config-repo.ts";
import {getKv, kvExpiryOptions, toClientKey, toSessionKey} from "./utils/kv.ts";
import {ClientData} from "@shared/api/api-config.ts";

export function init(app: Hono) {

    app.get(
        "/api/config",
        c => c.json(configuration)
    );

    app.post(
        "api/client/:id",
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
}