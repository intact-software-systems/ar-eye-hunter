import {ClientData, LoginRequest, LoginResponse} from "@shared/api/api-config.ts";
import {authorisedClients} from "../utils/config-repo.ts";

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
        sessionId: sessionId
    }
}

export function mockedClients(): ClientData[] {
    return authorisedClients
        .map(c => ({
            clientId: c.clientId,
            sessionId: c.clientId
        }))
}
