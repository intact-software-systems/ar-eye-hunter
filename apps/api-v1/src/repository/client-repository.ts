import { ClientData, LoginRequest, LoginResponse } from "@shared/api/api-config.ts";
import { authorisedClients } from "../utils/config-repo.ts";

type CacheWrapper<T> = {
    value: T;
    lastUpdated: number;
}

const clientDataById = new Map<string, CacheWrapper<ClientData>>();

function isCacheExpired(newVar: CacheWrapper<ClientData>) {
    return newVar?.lastUpdated < Date.now() - 1000 * 60 * 5;
}

export function findOnlineClientDataById(id: string): ClientData | undefined {
    const newVar = clientDataById.get(id);

    if (newVar && isCacheExpired(newVar)) {
        console.log(`Client ${id} expired from cache`);
        clientDataById.delete(id);
        return undefined;
    }

    return newVar?.value;
}

export function setClientDataById(id: string, data: ClientData): void {
    clientDataById.set(
        id, {
            value: data,
            lastUpdated: Date.now()
        }
    );
}

export function readAllOnlineClients(): ClientData[] {
    return Array.from(
        clientDataById.values()
            .filter((wrapper) => !isCacheExpired(wrapper))
            .map<ClientData>((wrapper) => wrapper.value)
            .toArray()
    );
}

function toSessionId(clientId: string) {
    return clientId + crypto.randomUUID().substring(0, 5);
}

function toClientId(sessionId: string) {
    return sessionId.substring(0, sessionId.length - 5);
}

export function login(loginRequest: LoginRequest): LoginResponse | undefined {
    for (const client of authorisedClients) {
        if (client.username === loginRequest.username && client.password === loginRequest.password) {
            return {
                clientId: client.clientId,
                accessToken: crypto.randomUUID().substring(0, 10),
                username: client.username,
                sessionId: toSessionId(client.clientId)
            }
        }
    }

    return undefined
}

export function findClientById(sessionId: string): ClientData | undefined {
    const clientId = toClientId(sessionId);

    const find = authorisedClients.find(client => client.clientId === clientId);

    if (!find) {
        return undefined
    }

    return {
        clientId: find.clientId,
        sessionId: sessionId,
        isOnline: false
    }
}

export function mockedClients(): ClientData[] {
    return authorisedClients
        .map(c => ({
            clientId: c.clientId,
            sessionId: c.clientId,
            isOnline: true
        }))
}
