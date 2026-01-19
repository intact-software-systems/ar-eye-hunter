import { health } from "./routes/health.ts";

Deno.serve((req) => {
    const url = new URL(req.url);

    if (url.pathname === '/api/health') {
        return health();
    }

    if (req.url.endsWith("/health")) {
        return health();
    }


    return new Response("Not Found", { status: 404 });
});
