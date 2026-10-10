import { request, type APIRequestContext, type APIResponse } from '@playwright/test';
import { mkdtempSync, rmSync } from 'node:fs';
import {
    createServer,
    type IncomingMessage,
    type Server,
    type ServerResponse
} from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect } from 'vitest';

import { toError } from '@shared/resilience/to-error.ts';

import { parseControlServerMessage } from '@shared-test/rallar-bb-test/control-protocol.ts';
import type { ControlRunSnapshot } from '@shared-test/rallar-bb-test/control-snapshots.ts';

import { toControlRunSnapshot } from '../../../apps/rallar-black-box-control-server/src/control-service-snapshots.ts';
import { type ControlRunState } from '../../../apps/rallar-black-box-control-server/src/control-service-state.ts';
import { createControlHttpResponses } from '../../../apps/rallar-black-box-control-server/src/http/control-http-responses.ts';
import { routeRunReadRequest } from '../../../apps/rallar-black-box-control-server/src/routes/run-routes-read.ts';
import { LiveRtcControlClient } from '../../../tests/playwright/rallar-black-box/live-rtc-control-client.ts';
import { normalizeJson, type LiveRtcJsonRecord } from '../../../tests/playwright/rallar-black-box/live-rtc-evidence-json.ts';

export namespace LiveRtcControlHttpFixture {
    export interface HttpResponse {
        readonly status: number;
        readonly body: string;
    }

    export interface RunRead {
        readonly url: string;
        readonly snapshot: ControlRunSnapshot;
    }

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
        runState: ControlRunState | undefined;
        runReads: RunRead[];
        responseOverrides: Map<string, HttpResponse>;
    }

    export interface Dependencies {
        readonly state: State;
        readonly server: Server;
        readonly request: APIRequestContext;
        readonly control: LiveRtcControlClient;
        readonly baseUrl: string;
        readonly diagnosticsRoot: string;
        readonly controlResponses: readonly APIResponse[];
        readonly externalResponse: APIResponse;
    }
}

export class LiveRtcControlHttpFixture {
    readonly state: LiveRtcControlHttpFixture.State;
    readonly request: APIRequestContext;
    readonly control: LiveRtcControlClient;
    readonly baseUrl: string;
    readonly diagnosticsRoot: string;
    readonly controlResponses: readonly APIResponse[];
    readonly externalResponse: APIResponse;
    readonly #server: Server;

    constructor(dependencies: LiveRtcControlHttpFixture.Dependencies) {
        this.state = dependencies.state;
        this.request = dependencies.request;
        this.control = dependencies.control;
        this.baseUrl = dependencies.baseUrl;
        this.diagnosticsRoot = dependencies.diagnosticsRoot;
        this.controlResponses = dependencies.controlResponses;
        this.externalResponse = dependencies.externalResponse;
        this.#server = dependencies.server;
    }

    async close(): Promise<void> {
        await this.request.dispose();
        await new Promise<void>((resolve, reject) => this.#server.close((error) => error ? reject(error) : resolve()));
        rmSync(this.diagnosticsRoot, { recursive: true, force: true });
    }

    async expectControlResponsesReleased(): Promise<void> {
        expect(this.controlResponses.length).toBeGreaterThan(0);
        for (const response of this.controlResponses) {
            expect.soft(await readResponseBodyRetention(response), response.url()).toMatch(/Response has been disposed$/);
        }
        expect((await this.externalResponse.body()).toString()).toBe('context remains reusable');
        await this.externalResponse.dispose();
        await expect(this.externalResponse.body()).rejects.toThrow('Response has been disposed');
        const nextResponse = await this.request.get(`${this.baseUrl}/runs/context-reuse`);
        expect(nextResponse.status()).toBe(200);
        await nextResponse.dispose();
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
        holdHealthCommand: undefined,
        runState: undefined,
        runReads: [],
        responseOverrides: new Map()
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
    const controlResponses: APIResponse[] = [];
    const externalResponse = await api.get(`${baseUrl}/runs/context-negative-control`);
    const observedRequest = createObservedRequest(api, controlResponses);
    const control = new LiveRtcControlClient({
        request: observedRequest,
        baseUrl,
        diagnosticsOutDir: diagnosticsRoot,
        monotonicNow: () => state.nowMs,
        epochNow: () => 0
    });
    return new LiveRtcControlHttpFixture({ state, server, request: api, control, baseUrl, diagnosticsRoot, controlResponses, externalResponse });
}

function createObservedRequest(api: APIRequestContext, responses: APIResponse[]): APIRequestContext {
    return new Proxy(api, {
        get(target, property) {
            if (property === 'get') {
                return async (...args: Parameters<APIRequestContext['get']>) => {
                    const response = await target.get(...args);
                    responses.push(response);
                    return response;
                };
            }
            if (property === 'post') {
                return async (...args: Parameters<APIRequestContext['post']>) => {
                    const response = await target.post(...args);
                    responses.push(response);
                    return response;
                };
            }
            return Reflect.get(target, property, target);
        }
    });
}

async function readResponseBodyRetention(response: APIResponse): Promise<string> {
    try {
        await response.body();
        return 'response body remains available';
    }
    catch (cause) {
        return toError(cause).message;
    }
}

async function writeLiveRtcControlResponse(state: LiveRtcControlHttpFixture.State, incoming: IncomingMessage, response: ServerResponse): Promise<void> {
    const override = state.responseOverrides.get(`${incoming.method} ${incoming.url}`);
    if (override) {
        response.writeHead(override.status, { 'content-type': 'application/json' }).end(override.body);
        return;
    }
    if (incoming.url === '/runs/context-negative-control' || incoming.url === '/runs/context-reuse') {
        response.writeHead(200).end('context remains reusable');
        return;
    }
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
        if (state.runState) {
            await writeLiveRtcQueuedCommandResponse(state.runState, incoming, response);
            return;
        }
        await writeLiveRtcHealthCommandResponse(state, incoming, response);
        return;
    }
    if (state.runState) {
        await writeLiveRtcRunSnapshotResponse(state, incoming, response);
        return;
    }
    response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ results: state.results, events: state.events }));
}

async function writeLiveRtcRunSnapshotResponse(
    state: LiveRtcControlHttpFixture.State,
    incoming: IncomingMessage,
    response: ServerResponse
): Promise<void> {
    const run = state.runState;
    if (!run) {
        throw new Error('Expected an owned run snapshot fixture.');
    }
    const url = new URL(incoming.url ?? '/', 'http://fixture.test');
    const routed = await routeRunReadRequest(url, {
        controlService: {
            snapshot: () => ({ runs: [] }),
            snapshotRun: (runId, bounds) => {
                if (runId !== run.runId) {
                    return undefined;
                }
                const snapshot = toControlRunSnapshot(run, bounds ?? {}, []);
                state.runReads.push({ url: url.pathname + url.search, snapshot });
                return snapshot;
            }
        },
        artifactRecorder: {
            response: async () => {
                throw new Error('Unexpected recorder fixture read.');
            }
        },
        responses: createControlHttpResponses([])
    });
    response.writeHead(routed?.status ?? 404, { 'content-type': 'application/json' }).end(await routed?.text());
}

async function writeLiveRtcQueuedCommandResponse(
    run: ControlRunState,
    incoming: IncomingMessage,
    response: ServerResponse
): Promise<void> {
    const chunks: Buffer[] = [];
    for await (const chunk of incoming) {
        chunks.push(Buffer.from(chunk));
    }
    const agentId = decodeURIComponent(incoming.url?.split('/')[4] ?? '');
    const parsed = parseControlServerMessage({
        ...JSON.parse(Buffer.concat(chunks).toString()),
        kind: 'command',
        protocolVersion: 1,
        runId: run.runId,
        agentId
    }, { runId: run.runId, agentId });
    if (!parsed.ok) {
        response.writeHead(400).end();
        return;
    }
    run.commands.set(parsed.envelope.commandId, {
        envelope: parsed.envelope,
        fingerprint: 'local-http-fixture',
        queuedAtEpochMs: 100,
        dispatchCount: 0
    });
    response.writeHead(202).end('{}');
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
