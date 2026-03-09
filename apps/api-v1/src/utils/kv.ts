/// <reference lib="deno.unstable" />
let kvPromise: Promise<Deno.Kv> | undefined = undefined;

export function getKv(): Promise<Deno.Kv> {
    if (!kvPromise) {
        kvPromise = Deno.openKv();
    }
    return kvPromise;
}

const SESSION_TTL_MS = 30 * 60 * 1000; // 30 minutes
export const kvExpiryOptions = {expireIn: SESSION_TTL_MS};


const clients = "clients";
const sessions = "sessions";
const rooms = "rooms";


export function toClientsPrefix() {
    return {prefix: [clients]}
}

export function toSessionsPrefix() {
    return {prefix: [sessions]}
}

export function toClientKey(id: string): Deno.KvKey {
    return [clients, id]
}

export function toSessionKey(id: string): Deno.KvKey {
    return [sessions, id]
}

export function toRoomKey(name: string): Deno.KvKey {
    return [rooms, name]
}

export function toRoomsPrefix() {
    return {prefix: [rooms]}
}
