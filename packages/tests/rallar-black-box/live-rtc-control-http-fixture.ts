import { request, type APIRequestContext } from '@playwright/test';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { LiveRtcControlClient } from '../../../tests/playwright/rallar-black-box/live-rtc-control-client.ts';
import { normalizeJson, type LiveRtcJsonRecord } from '../../../tests/playwright/rallar-black-box/live-rtc-evidence-json.ts';

export namespace LiveRtcControlHttpFixture {
    export interface State {
        nowMs: number;
        readyPeerIds: string[];
        rtcDiagnosticPeers: LiveRtcJsonRecord[];
        formation: LiveRtcJsonRecord | undefined;
        results: LiveRtcControlClient.Result[];
        events: LiveRtcControlClient.Event[];
        artifactRunId: string | undefined;
        artifactBundle: LiveRtcJsonRecord | undefined;
        resultsJsonl: string;
        resultsStatus: number;
        recorderOpenEnded: boolean;
        recorderClosed: boolean;
        recorderJsonl: string;
        recorderStatus: number;
        recorderReads: number;
        recorderUrls: string[];
        captureEffects: string[];
        healthCommandFailure: { agentId: string; body: string; } | undefined;
        holdHealthCommand: ((agentId: string) => Promise<void>) | undefined;
    }

    export interface Dependencies {
        readonly state: State;
        readonly server: Server;
        readonly request: APIRequestContext;
        readonly control: LiveRtcControlClient;
        readonly baseUrl: string;
        readonly diagnosticsRoot: string;
    }
}

export class LiveRtcControlHttpFixture {
    readonly state: LiveRtcControlHttpFixture.State;
    readonly request: APIRequestContext;
    readonly control: LiveRtcControlClient;
    readonly baseUrl: string;
    readonly diagnosticsRoot: string;
    readonly #server: Server;

    constructor(dependencies: LiveRtcControlHttpFixture.Dependencies) {
        this.state = dependencies.state;
        this.request = dependencies.request;
        this.control = dependencies.control;
        this.baseUrl = dependencies.baseUrl;
        this.diagnosticsRoot = dependencies.diagnosticsRoot;
        this.#server = dependencies.server;
    }

    async close(): Promise<void> {
        await this.request.dispose();
        await new Promise<void>((resolve, reject) => this.#server.close((error) => error ? reject(error) : resolve()));
        rmSync(this.diagnosticsRoot, { recursive: true, force: true });
    }
}

export async function createDefaultLiveRtcControlHttpFixture(): Promise<LiveRtcControlHttpFixture> {
    const state: LiveRtcControlHttpFixture.State = {
        nowMs: 100,
        readyPeerIds: ['session-b', 'session-c'],
        rtcDiagnosticPeers: [],
        formation: undefined,
        results: [],
        events: [],
        artifactRunId: undefined,
        artifactBundle: undefined,
        resultsJsonl: '',
        resultsStatus: 200,
        recorderOpenEnded: false,
        recorderClosed: false,
        recorderJsonl: '',
        recorderStatus: 200,
        recorderReads: 0,
        recorderUrls: [],
        captureEffects: [],
        healthCommandFailure: undefined,
        holdHealthCommand: undefined
    };
    const diagnosticsRoot = mkdtempSync(path.join(tmpdir(), 'live-rtc-control-client-'));
    const server = createServer(async (incoming, response) => await writeLiveRtcControlResponse(state, incoming, response));
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
    return new LiveRtcControlHttpFixture({ state, server, request: api, control, baseUrl, diagnosticsRoot });
}

async function writeLiveRtcControlResponse(state: LiveRtcControlHttpFixture.State, incoming: IncomingMessage, response: ServerResponse): Promise<void> {
    if (state.artifactRunId !== undefined && incoming.url?.split('/')[2] !== encodeURIComponent(state.artifactRunId)) {
        response.writeHead(404).end();
        return;
    }
    if (incoming.url?.endsWith('/artifacts')) {
        response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(state.artifactBundle));
        return;
    }
    if (incoming.url?.endsWith('/results.jsonl')) {
        response.writeHead(state.resultsStatus, { 'content-type': 'application/x-ndjson' }).end(state.resultsJsonl);
        return;
    }
    if (incoming.url?.endsWith('/events.jsonl')) {
        state.recorderUrls.push(incoming.url);
        state.recorderReads += 1;
        state.captureEffects.push('history');
        response.once('close', () => {
            state.recorderClosed = true;
        });
        response.writeHead(state.recorderStatus, { 'content-type': 'application/x-ndjson' });
        if (state.recorderOpenEnded) {
            response.write(state.recorderJsonl);
        }
        else {
            response.end(state.recorderJsonl);
        }
        return;
    }
    if (incoming.method === 'POST') {
        await writeLiveRtcHealthCommandResponse(state, incoming, response);
        return;
    }
    response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ results: state.results, events: state.events }));
}

async function writeLiveRtcHealthCommandResponse(state: LiveRtcControlHttpFixture.State, incoming: IncomingMessage, response: ServerResponse): Promise<void> {
    const chunks: Buffer[] = [];
    for await (const chunk of incoming) {
        chunks.push(Buffer.from(chunk));
    }
    const command = normalizeJson(JSON.parse(Buffer.concat(chunks).toString()));
    if (!command || typeof command !== 'object' || !('commandId' in command) || typeof command.commandId !== 'string') {
        response.writeHead(400).end();
        return;
    }
    const agentId = incoming.url?.split('/')[4];
    state.captureEffects.push(`health:${agentId}`);
    if (
        state.healthCommandFailure && agentId === state.healthCommandFailure.agentId &&
        (command.commandId.startsWith('health-') || command.commandId.startsWith('rtc-diagnostics-'))
    ) {
        response.writeHead(500).end(state.healthCommandFailure.body);
        return;
    }
    if (state.holdHealthCommand && command.commandId.startsWith('health-message-failure-')) {
        await state.holdHealthCommand(agentId ?? 'missing-agent');
    }
    state.results.push(toLiveRtcHealthResult(state, agentId, command.commandId));
    response.writeHead(202).end('{}');
}

function toLiveRtcHealthResult(state: LiveRtcControlHttpFixture.State, agentId: string | undefined, commandId: string): LiveRtcControlClient.Result {
    return {
        agentId,
        commandId,
        ok: true,
        result: {
            value: {
                credential: 'secret-health-root-sentinel',
                rallar: {
                    session: { accessToken: 'secret-health-session-sentinel' },
                    ...(state.formation ? { formation: state.formation } : {}),
                    rtcStatus: { activePeerIds: state.readyPeerIds, readyPeerIds: state.readyPeerIds },
                    rtcDiagnostics: {
                        sessionId: 'health-session',
                        generatedAtEpochMs: 0,
                        peerCount: state.rtcDiagnosticPeers.length,
                        connectedPeerCount: state.rtcDiagnosticPeers.length,
                        relayPeerCount: 0,
                        peers: state.rtcDiagnosticPeers
                    }
                }
            }
        }
    };
}
