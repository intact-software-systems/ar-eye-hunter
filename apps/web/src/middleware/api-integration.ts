import {apiBaseUrl} from "./config.ts";
import {ApiConfig, ClientData} from "@shared/api/api-config.ts";

async function readTextOrElse(res: Response, orElse: () => string): Promise<string> {
    try {
        return await res.text();
    } catch {
        return orElse();
    }
}

async function executeHttpRequest<TReq, TRes>(
    baseUrl: string,
    path: string,
    method: 'GET' | 'POST',
    body: TReq | undefined
): Promise<TRes> {
    const url = `${baseUrl}${path}`;

    const init: RequestInit = {
        method,
        headers: {'content-type': 'application/json'},
    };

    if (method === 'POST') {
        if (!body) {
            throw new Error(`POST ${path} requires a body`);
        }
        init.body = JSON.stringify(body);
    }

    const res = await fetch(url, init);

    if (!res.ok) {
        const txt = await readTextOrElse(res, () => '');

        throw new Error(`API ${method} ${path} failed: ${res.status} ${txt}`);
    }

    return (await res.json()) as TRes;
}

export async function readApiConfig(): Promise<ApiConfig> {
    return await executeHttpRequest<void, ApiConfig>(
        apiBaseUrl,
        '/api/config',
        'GET',
        undefined
    )
}

export async function postClientData(clientData: ClientData): Promise<void> {
    return await executeHttpRequest<ClientData, void>(
        apiBaseUrl,
        '/api/client/' + clientData.clientId,
        'POST',
        clientData
    )
}

export async function readClients(): Promise<ClientData[]> {
    return await executeHttpRequest<void, ClientData[]>(
        apiBaseUrl,
        '/api/read/clients',
        'GET',
        undefined
    )
}