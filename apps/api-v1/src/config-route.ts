import {Hono} from "jsr:@hono/hono";
import {configuration} from "./utils/config-repo.ts";

export function initialise(app: Hono) {

    app.get(
        "/api/config",
        c => c.json(configuration)
    );
}