import { ClientData } from "@shared/api/api-config.ts";

const clientDataById = new Map<string, ClientData>();

export function findClientDataById(id: string): ClientData | undefined {
    return clientDataById.get(id);
}

export function setClientDataById(id: string, data: ClientData): void {
    clientDataById.set(id, data);
}

export function getAllClientData(): ClientData[] {
    return Array.from(clientDataById.values());
}
