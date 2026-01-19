import { HealthResponse } from "@shared/api/health.ts";

export function health(): Response {
    const body: HealthResponse = {
        status: "ok",
        version: "0.1.0",
    };

    return Response.json(body);
}
