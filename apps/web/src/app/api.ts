import type { HealthResponse } from "@shared/api/health.ts";

export async function getHealth(): Promise<HealthResponse> {
    const res = await fetch("/api/health");
    return res.json();
}
