import {Hono} from "jsr:@hono/hono";
import {cors} from "jsr:@hono/hono/cors";
import {qboxEngine} from "./utils/qbox-engine.ts";
import * as wsRelayer from "./websocket/ws-routes.ts";

// -------------------------------------
// Initialise
// -------------------------------------

qboxEngine.start()

// -------------------------------------
// App with routes
// -------------------------------------

const app: Hono = new Hono();

app.use(
    "/api/*",
    cors(
        {
            origin: "http://localhost:3000", // Your SPA's address
            allowMethods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
            allowHeaders: ["Content-Type", "Authorization"],
            exposeHeaders: ["Content-Length"],
            maxAge: 600, // Cache the preflight for 10 minutes
            credentials: true,
        }
    )
);

// Your routes now don't need to worry about OPTIONS
// app.post("/api/game/setup", (c) => c.json({ok: true}));

wsRelayer.initialise(app)

Deno.serve(app.fetch)
console.log("Server started on port 8000");


