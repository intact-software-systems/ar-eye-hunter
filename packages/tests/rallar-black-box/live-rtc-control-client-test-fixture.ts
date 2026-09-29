import { request, type APIRequestContext } from '@playwright/test';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { vi } from 'vitest';

import { LiveRtcControlClient } from '../../../tests/playwright/rallar-black-box/live-rtc-control-client.ts';
import { normalizeJson, type LiveRtcJsonRecord } from '../../../tests/playwright/rallar-black-box/live-rtc-evidence-json.ts';

export interface LiveRtcControlClientTestState {
    nowMs: number;
    readyPeerIds: string[];
    results: LiveRtcControlClient.Result[];
    events: LiveRtcControlClient.Event[];
    healthCommandFailure: { agentId: string; body: string; } | undefined;
    holdHealthCommand: ((agentId: string) => Promise<void>) | undefined;
    healthValues: Record<string, LiveRtcJsonRecord>;
    runAgentIds: string[];
    readinessHealthAgents: string[];
    failureHealthCommandIds: string[];
}

export async function createLiveRtcControlClientTestFixture() {
    const state: LiveRtcControlClientTestState = {
        nowMs: 100,
        readyPeerIds: ['session-b', 'session-c'],
        results: [],
        events: [],
        healthCommandFailure: undefined,
        holdHealthCommand: undefined,
        healthValues: {},
        runAgentIds: ['agent-a'],
        readinessHealthAgents: [],
        failureHealthCommandIds: []
    };
    const diagnosticsRoot = mkdtempSync(path.join(tmpdir(), 'live-rtc-control-client-'));
    const server = createServer(async (incoming, response) => {
        if (incoming.method === 'POST') {
            await handleCommand(state, incoming, response);
            return;
        }
        response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({
            agents: state.runAgentIds.map((agentId) => ({ agentId })),
            results: state.results,
            events: state.events
        }));
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') {
        throw new Error('Expected a local control HTTP port.');
    }
    const api = await request.newContext();
    const baseUrl = `http://127.0.0.1:${address.port}`;
    const control = new LiveRtcControlClient({
        request: api,
        baseUrl,
        diagnosticsOutDir: diagnosticsRoot,
        monotonicNow: () => state.nowMs,
        epochNow: () => 0
    });
    const refreshRoom = vi.fn<LiveRtcControlClient.FormationAgent['refreshRoom']>();
    refreshRoom.mockResolvedValue(undefined);
    const agent = { agentId: 'agent-a', prefix: 'A' as const, refreshRoom };
    return {
        state,
        diagnosticsRoot,
        api,
        baseUrl,
        control,
        refreshRoom,
        agent,
        close: async () => await closeFixture({ server, api, diagnosticsRoot, refreshRoom })
    };
}

async function handleCommand(
    state: LiveRtcControlClientTestState,
    incoming: IncomingMessage,
    response: ServerResponse
): Promise<void> {
    const commandId = await readCommandId(incoming);
    if (commandId === null) {
        response.writeHead(400).end();
        return;
    }
    const encodedAgentId = incoming.url?.split('/')[4];
    const agentId = encodedAgentId === undefined ? undefined : decodeURIComponent(encodedAgentId);
    if (commandId.startsWith('health-readiness-failure-')) {
        state.readinessHealthAgents.push(agentId ?? 'missing-agent');
    }
    if (/^health-(message|readiness|nack)-failure-/u.test(commandId)) {
        state.failureHealthCommandIds.push(commandId);
    }
    if (
        state.healthCommandFailure && agentId === state.healthCommandFailure.agentId &&
        /health-(message|readiness)-failure-/.test(commandId)
    ) {
        response.writeHead(500).end(state.healthCommandFailure.body);
        return;
    }
    if (state.holdHealthCommand && /health-(message|readiness)-failure-/.test(commandId)) {
        await state.holdHealthCommand(agentId ?? 'missing-agent');
    }
    if (!state.results.some((result) => result.commandId === commandId)) {
        state.results.push({
            agentId,
            commandId,
            ok: true,
            result: {
                value: state.healthValues[agentId ?? ''] ?? {
                    rallar: {
                        rtcStatus: { activePeerIds: state.readyPeerIds, readyPeerIds: state.readyPeerIds },
                        rtcDiagnostics: {
                            sessionId: 'health-session',
                            generatedAtEpochMs: 0,
                            peerCount: 0,
                            connectedPeerCount: 0,
                            relayPeerCount: 0,
                            peers: []
                        }
                    }
                }
            }
        });
    }
    response.writeHead(202).end('{}');
}

async function readCommandId(incoming: IncomingMessage): Promise<string | null> {
    const chunks: Buffer[] = [];
    for await (const chunk of incoming) {
        chunks.push(Buffer.from(chunk));
    }
    const command = normalizeJson(JSON.parse(Buffer.concat(chunks).toString()));
    return command && typeof command === 'object' && 'commandId' in command &&
            typeof command.commandId === 'string'
        ? command.commandId
        : null;
}

async function closeFixture(input: {
    readonly server: Server;
    readonly api: APIRequestContext;
    readonly diagnosticsRoot: string;
    readonly refreshRoom: ReturnType<typeof vi.fn<LiveRtcControlClient.FormationAgent['refreshRoom']>>;
}): Promise<void> {
    await input.api.dispose();
    await new Promise<void>((resolve, reject) => input.server.close((error) => (error ? reject(error) : resolve())));
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    input.refreshRoom.mockReset();
    rmSync(input.diagnosticsRoot, { recursive: true, force: true });
}
