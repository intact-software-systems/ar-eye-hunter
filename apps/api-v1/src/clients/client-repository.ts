import {ClientData, LoginRequest, LoginResponse} from "@shared/api/api-config.ts";
import {authorisedClients} from "../utils/config-repo.ts";

export function login(loginRequest: LoginRequest): LoginResponse | undefined {
    for (const client of authorisedClients) {
        if (client.username === loginRequest.username && client.password === loginRequest.password) {
            return {
                clientId: client.clientId,
                accessToken: crypto.randomUUID().substring(0, 10),
                username: client.username,
            }
        }
    }

    return undefined
}

export function findClientById(clientId: string): ClientData | undefined {
    const find = authorisedClients.find(client => client.clientId === clientId);

    if (!find) {
        return undefined
    }

    return {
        clientId: find.clientId,
        sessionId: find.clientId
    }
}

export function mockedClients(): ClientData[] {
    return authorisedClients
        .map(c => ({
            clientId: c.clientId,
            sessionId: c.clientId
        }))
}
