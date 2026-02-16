/// <reference lib="deno.unstable" />
import "jsr:@std/dotenv/load";
import {route} from 'jsr:@std/http/unstable-route';
import {toCorsHeaders, toNotFoundResponse, withCors} from "./utils/utils.ts";
import {iceRoutes} from "./webrtc/ice_routes.ts";

let handleRequest = route(
    [
        ...iceRoutes()
    ],
    () => toNotFoundResponse()
);

Deno.serve(async (req) => {
    // Handle preflight
    if (req.method === 'OPTIONS') {
        return new Response(null, {status: 204, headers: toCorsHeaders(req)});
    }

    const res = await handleRequest(req);

    return withCors(req, res);
});

