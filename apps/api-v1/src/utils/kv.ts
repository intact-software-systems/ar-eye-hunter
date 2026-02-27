/// <reference lib="deno.unstable" />
let kvPromise: Promise<Deno.Kv> | undefined = undefined;

export function getKv(): Promise<Deno.Kv> {
    if (!kvPromise) {
        kvPromise = Deno.openKv();
    }
    return kvPromise;
}

export function toClientKey(id: string): Deno.KvKey {
    return ["client", id]
}

export function toSessionKey(id: string): Deno.KvKey {
    return ["session", id]
}

const SESSION_TTL_MS = 30 * 60 * 1000; // 30 minutes
export const kvExpiryOptions = { expireIn: SESSION_TTL_MS };

