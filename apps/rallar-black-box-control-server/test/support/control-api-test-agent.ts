import { getJson } from './control-api-test-server.ts';

export async function registerAgent(
    baseUrl: string,
    runId: string,
    agentId: string
): Promise<WebSocket> {
    const socket = new WebSocket(`${baseUrl.replace(/^http/, 'ws')}/control`);
    await waitForSocketOpen(socket);
    socket.send(JSON.stringify({
        kind: 'register',
        protocolVersion: 1,
        runId,
        agentId,
        atEpochMs: Date.now(),
        identity: {
            applicationId: 'rallar-server',
            workspaceId: 'default',
            groupId: 'bb-group',
            region: 'eu-north',
            provider: 'black-box-test'
        },
        resume: {
            completedCommandIds: []
        }
    }));
    await waitForAgent(baseUrl, runId, agentId);
    return socket;
}

export function waitForSocketOpen(socket: WebSocket): Promise<void> {
    if (socket.readyState === WebSocket.OPEN) {
        return Promise.resolve();
    }
    return new Promise((resolve, reject) => {
        const timeout = setTimeout(
            () => reject(new Error('WebSocket did not open.')),
            5_000
        );
        socket.addEventListener('open', () => {
            clearTimeout(timeout);
            resolve();
        }, { once: true });
        socket.addEventListener('error', () => {
            clearTimeout(timeout);
            reject(new Error('WebSocket failed to open.'));
        }, { once: true });
    });
}

export function waitForSocketClose(socket: WebSocket): Promise<CloseEvent> {
    if (socket.readyState === WebSocket.CLOSED) {
        return Promise.resolve(new CloseEvent('close', { code: 1000 }));
    }
    return new Promise((resolve, reject) => {
        const timeout = setTimeout(
            () => reject(new Error('WebSocket did not close.')),
            5_000
        );
        socket.addEventListener('close', (event) => {
            clearTimeout(timeout);
            resolve(event);
        }, { once: true });
        socket.addEventListener('error', () => {
            clearTimeout(timeout);
            reject(new Error('WebSocket failed before close.'));
        }, { once: true });
    });
}

export async function waitForJsonl(
    baseUrl: string,
    path: string,
    marker: string
): Promise<string> {
    const deadline = Date.now() + 5_000;
    let lastText = '';
    while (Date.now() < deadline) {
        const response = await fetch(`${baseUrl}${path}`);
        if (response.ok) {
            lastText = await response.text();
            if (lastText.includes(marker)) {
                return lastText;
            }
        }
        await delay(50);
    }
    throw new Error(
        `JSONL ${path} did not include ${marker}. Last body: ${lastText}`
    );
}

export async function waitForPersistedSnapshot(
    storageDir: string,
    marker: string
): Promise<void> {
    const path = `${storageDir}/control-snapshot.json`;
    const deadline = Date.now() + 5_000;
    while (Date.now() < deadline) {
        try {
            const text = await Deno.readTextFile(path);
            if (text.includes(marker)) {
                return;
            }
        }
        catch {
            // Persistence completes asynchronously after each write request.
        }
        await delay(50);
    }
    throw new Error(`Persisted snapshot did not include ${marker}.`);
}

export async function waitForPathMissing(path: string): Promise<void> {
    const deadline = Date.now() + 5_000;
    while (Date.now() < deadline) {
        try {
            await Deno.stat(path);
        }
        catch (error) {
            if (error instanceof Deno.errors.NotFound) {
                return;
            }
            throw error;
        }
        await delay(25);
    }
    throw new Error(`Path was not removed: ${path}`);
}

async function waitForAgent(
    baseUrl: string,
    runId: string,
    agentId: string
): Promise<void> {
    const deadline = Date.now() + 5_000;
    while (Date.now() < deadline) {
        const response = await fetch(
            `${baseUrl}/runs/${encodeURIComponent(runId)}`
        );
        if (response.ok) {
            const run = await response.json() as {
                agents?: readonly { agentId: string; connected: boolean; }[];
            };
            if (
                run.agents?.some((agent) => agent.agentId === agentId && agent.connected)
            ) {
                return;
            }
        }
        await delay(50);
    }
    const run = await getJson<{
        agents?: readonly { agentId: string; connected: boolean; }[];
    }>(baseUrl, `/runs/${encodeURIComponent(runId)}`);
    throw new Error(
        `Agent ${agentId} did not register for ${runId}; observed ${run.agents?.length ?? 0} agents.`
    );
}

function delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}
