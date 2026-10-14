import type { BrowserContext, Route } from '@playwright/test';

import type {
    ControlAgentSnapshot,
    ControlDistributedRunSnapshot,
    ControlRunSnapshot,
    ControlServerSnapshot
} from '../../../packages/shared-test/rallar-bb-test/control-snapshots.ts';
import type {
    RallarBlackBoxDistributedRunManifest,
    RallarBlackBoxDistributedRunState,
    RallarBlackBoxDistributedTargetResolution
} from '../../../packages/shared-test/rallar-bb-test/distributed-run.ts';

import { createExecuteScaleSnapshot } from './recipe-console-scale-control-fixture.ts';

export const EXECUTE_API_ROUTE = /https?:\/\/(?:localhost|127\.0\.0\.1):8080\/.*/;
export const EXECUTE_CONTROL_ROUTE = /https?:\/\/(?:localhost|127\.0\.0\.1):5180\/.*/;
export const EXECUTE_CONTROL_GROUP = {
    applicationId: 'rallar-server',
    workspaceId: 'default',
    groupId: 'execute-live-group'
} as const;

interface ExecuteAgentConfiguration {
    readonly connected?: boolean;
    readonly groupId?: string;
}

interface ExecuteManifestRequest {
    readonly manifest?: RallarBlackBoxDistributedRunManifest;
}

interface DistributedRunFixtureInput {
    readonly manifest: RallarBlackBoxDistributedRunManifest;
    readonly state: RallarBlackBoxDistributedRunState;
    readonly updatedAtEpochMs: number;
    readonly error?: ControlDistributedRunSnapshot['error'];
}

export function createExecuteAgent(
    runId: string,
    agentId: string,
    options: ExecuteAgentConfiguration = {}
): ControlAgentSnapshot {
    const now = Date.now();
    return {
        runId,
        agentId,
        connected: options.connected ?? true,
        registeredAtEpochMs: now - 2_000,
        lastSeenAtEpochMs: now - 500,
        lastHeartbeatAtEpochMs: now - 500,
        status: options.connected === false ? 'offline' : 'connected',
        identity: {
            principalId: `${agentId}-principal`,
            sessionId: `${agentId}-session`,
            ...EXECUTE_CONTROL_GROUP,
            groupId: options.groupId ?? EXECUTE_CONTROL_GROUP.groupId,
            providerMode: 'browser-rallar',
            browserName: 'chromium',
            region: 'eu-north',
            sessionLabel: `${agentId}-principal:${agentId}-session`,
            updatedAtEpochMs: now - 500
        },
        connectionSequence: 1,
        reconnectCount: 0,
        receivedResultCount: 0,
        receivedEventCount: 0,
        completedCommandIds: [],
        resumeCompletedCommandIds: []
    };
}

export function createExecuteLiveSnapshot(): ControlServerSnapshot {
    const runId = 'execute-control-a';
    const now = Date.now();
    const run: ControlRunSnapshot = {
        runId,
        createdAtEpochMs: now - 10_000,
        updatedAtEpochMs: now - 500,
        agents: [
            createExecuteAgent(runId, 'execute-agent-a'),
            createExecuteAgent(runId, 'execute-agent-b')
        ],
        commands: [],
        results: [],
        events: [],
        stats: [],
        reports: [],
        heartbeats: []
    };
    return { runs: [run], distributedRuns: [] };
}

export async function fulfillExecuteJsonResponse(
    route: Route,
    // HTTP fixtures serialize values without interpreting application payloads.
    body: unknown,
    status = 200
): Promise<void> {
    await route.fulfill({
        status,
        contentType: 'application/json',
        headers: { 'access-control-allow-origin': '*' },
        body: JSON.stringify(body)
    });
}

export function createExecuteRunSnapshot(
    { manifest, state, updatedAtEpochMs, error }: DistributedRunFixtureInput
): ControlDistributedRunSnapshot {
    const targetAgentIds = [...selectedAgentIds(manifest)];
    const ready = ['ready', 'running', 'passed'].includes(state)
        ? targetAgentIds.length
        : 0;
    return {
        distributedRunId: manifest.distributedRunId,
        controlRunId: manifest.controlRunId ?? '',
        manifest,
        state,
        createdAtEpochMs: updatedAtEpochMs - 1_000,
        updatedAtEpochMs,
        targetAgentIds,
        commandLinks: [],
        rollup: {
            state,
            ok: state === 'passed',
            summary: {
                participants: targetAgentIds.length,
                readyParticipants: ready,
                passedParticipants: state === 'passed' ? targetAgentIds.length : 0,
                failedParticipants: state === 'failed' ? targetAgentIds.length : 0,
                recipes: manifest.recipes.length,
                passedRecipes: state === 'passed' ? manifest.recipes.length : 0,
                failedRecipes: state === 'failed' ? manifest.recipes.length : 0,
                groupAssertions: 0,
                passedGroupAssertions: 0,
                failedGroupAssertions: 0,
                blockingFailures: state === 'failed' ? 1 : 0
            },
            failures: []
        },
        error
    };
}

function selectedAgentIds(manifest: RallarBlackBoxDistributedRunManifest): readonly string[] {
    return manifest.targetPolicy.mode === 'selected-agents' ? manifest.targetPolicy.agentIds : [];
}

function targetResolution(
    manifest: RallarBlackBoxDistributedRunManifest,
    targetAgentIds = selectedAgentIds(manifest)
): RallarBlackBoxDistributedTargetResolution {
    return {
        group: manifest.group,
        resolvedAtEpochMs: Date.now(),
        staleAfterMs: 30_000,
        targetPolicyMode: manifest.targetPolicy.mode,
        targetAgentIds,
        roleAssignments: targetAgentIds.map((agentId) => ({
            agentId,
            role: 'all-agents',
            recipeIds: manifest.recipes
                .map(
                    (recipe) => recipe.recipeId ?? recipe.recipe?.recipeId ?? ''
                )
                .filter(Boolean),
            variables: {}
        })),
        blockers: [],
        summary: {
            agents: targetAgentIds.length,
            targetable: targetAgentIds.length,
            selected: targetAgentIds.length,
            expectedParticipantCount: manifest.targetPolicy.expectedParticipantCount,
            missingExpectedParticipants: 0,
            staleAgents: 0,
            offlineAgents: 0,
            wrongGroupAgents: 0,
            assertionCapabilityBlockedAgents: 0,
            agentsWithoutIdentity: 0,
            roleCounts: { 'all-agents': targetAgentIds.length },
            regions: { 'eu-north': targetAgentIds.length },
            providers: { 'browser-rallar': targetAgentIds.length }
        }
    };
}

export function createExecutePressureSnapshot(): ControlServerSnapshot {
    const snapshot = createExecuteScaleSnapshot();
    const now = Date.now();
    return {
        ...snapshot,
        runs: snapshot.runs.map((run, index) => ({
            ...run,
            createdAtEpochMs: now - (snapshot.runs.length - index) * 1_000,
            updatedAtEpochMs: now - 500,
            agents: run.agents.map((agent) => ({
                ...agent,
                registeredAtEpochMs: now - 2_000,
                lastSeenAtEpochMs: now - 500,
                lastHeartbeatAtEpochMs: now - 500,
                identity: agent.identity ? { ...agent.identity, updatedAtEpochMs: now - 500 } : undefined
            }))
        }))
    };
}

export namespace ExecuteControlFixture {
    export interface TokenRequest {
        readonly runId: string;
        readonly agentId: string;
    }
    export interface WriteFailure {
        readonly path: string;
        readonly status: number;
        readonly message: string;
    }
    export interface Write {
        readonly path: string;
        readonly authorization: string | undefined;
        readonly manifest?: RallarBlackBoxDistributedRunManifest;
    }
    export interface Options {
        /** Omitted for read-only and untrusted endpoints; never seeds ambient credentials. */
        readonly operatorSession?: boolean;
        /** Omitted only for the maintained localhost Execute controller. */
        readonly controlRoute?: string | RegExp;
        readonly snapshot?: ControlServerSnapshot;
        readonly enableAgentLaunch?: boolean;
        readonly refreshAgentEvidence?: boolean;
        resolutionTargetIds?(call: number, manifest: RallarBlackBoxDistributedRunManifest): readonly string[];
        readonly failure?: WriteFailure;
        readonly createResponseDistributedRunId?: string;
        readonly deferResolution?: boolean;
    }
}

export class ExecuteControlFixture {
    readonly successfulWrites: ExecuteControlFixture.Write[] = [];
    readonly controlAuthorizations: Array<string | null> = [];
    readonly brokerAuthorizations: string[] = [];
    readonly tokenRequests: ExecuteControlFixture.TokenRequest[] = [];
    private readonly options: ExecuteControlFixture.Options;
    private base: ControlServerSnapshot;
    private latestResponseBase: ControlServerSnapshot;
    private run: ControlDistributedRunSnapshot | undefined;
    private version = Date.now();
    private waitingReads = 0;
    private runningReads = 0;
    private runReads = 0;
    private resolutionCalls = 0;
    private readonly createdRunIds = new Set<string>();
    private shouldDeferNextRunRead = false;
    private readonly resolutionStarted = Promise.withResolvers<void>();
    private readonly resolutionGate = Promise.withResolvers<void>();
    private readonly runReadStarted = Promise.withResolvers<void>();
    private readonly runReadGate = Promise.withResolvers<void>();

    constructor(options: ExecuteControlFixture.Options) {
        this.options = options;
        this.base = options.snapshot ?? createExecuteLiveSnapshot();
        this.latestResponseBase = this.base;
        this.run = this.base.distributedRuns?.[0];
    }

    async install(context: BrowserContext): Promise<void> {
        if (this.options.operatorSession) {
            await context.addInitScript(() =>
                localStorage.setItem(
                    'auth.session',
                    JSON.stringify({
                        clientId: 'execute-client',
                        sessionId: 'execute-session',
                        username: 'execute-operator',
                        accessToken: 'execute-primary-session-token',
                        expiresAtEpochMs: 4_000_000_000_000
                    })
                )
            );
            await context.route(EXECUTE_API_ROUTE, async (route) => {
                if (route.request().method() === 'OPTIONS') {
                    await fulfillCorsPreflight(route);
                    return;
                }
                this.brokerAuthorizations.push(route.request().headers().authorization ?? 'missing');
                await fulfillExecuteJsonResponse(route, {
                    tokenType: 'Bearer',
                    token: 'execute-brokered-operator-token',
                    issuedAtEpochMs: Date.now(),
                    expiresAtEpochMs: Date.now() + 3_600_000,
                    ttlMs: 3_600_000
                });
            });
        }
        await context.route(
            this.options.controlRoute ?? EXECUTE_CONTROL_ROUTE,
            (route) => this.serveControlRequest(route)
        );
    }

    runRequestCount(): number {
        return this.runReads;
    }
    waitForDeferredResolution(): Promise<void> {
        return this.resolutionStarted.promise;
    }
    releaseDeferredResolution(): void {
        this.resolutionGate.resolve();
    }
    deferNextRunRead(): void {
        this.shouldDeferNextRunRead = true;
    }
    waitForDeferredRunRead(): Promise<void> {
        return this.runReadStarted.promise;
    }
    releaseDeferredRunRead(): void {
        this.runReadGate.resolve();
    }
    setRunState(state: RallarBlackBoxDistributedRunState, error?: ControlDistributedRunSnapshot['error']): void {
        if (!this.run) {
            throw new Error('A distributed run must exist before its state can change.');
        }
        this.run = createExecuteRunSnapshot({
            manifest: this.run.manifest,
            state,
            updatedAtEpochMs: ++this.version,
            error
        });
    }

    private async serveControlRequest(route: Route): Promise<void> {
        const request = route.request();
        const pathname = new URL(request.url()).pathname;
        if (request.method() === 'OPTIONS') {
            await fulfillCorsPreflight(route);
            return;
        }
        const token = pathname.match(/^\/runs\/([^/]+)\/agents\/([^/]+)\/tokens$/);
        if (this.options.enableAgentLaunch && request.method() === 'POST' && token) {
            await this.issueAgentToken(route, decodeURIComponent(token[1]), decodeURIComponent(token[2]));
            return;
        }
        const authorization = request.headers().authorization;
        this.controlAuthorizations.push(authorization ?? null);
        if (
            (request.method() === 'POST' || pathname.endsWith('/artifacts')) &&
            authorization !== 'Bearer execute-brokered-operator-token'
        ) {
            await fulfillExecuteJsonResponse(route, { error: 'Operator token required.' }, 401);
            return;
        }
        if (request.method() === 'POST') {
            await this.serveRunWrite(route, pathname, authorization);
            return;
        }
        if (request.method() === 'GET') {
            await this.serveControlRead(route, pathname, authorization);
            return;
        }
        await fulfillExecuteJsonResponse(route, { error: `Unhandled ${request.method()} ${pathname}` }, 404);
    }

    private async serveControlRead(route: Route, pathname: string, authorization: string | undefined): Promise<void> {
        if (pathname === '/runs') {
            await this.readSnapshot(route);
            return;
        }
        const detail = pathname.match(/^\/runs\/([^/]+)$/);
        if (detail) {
            await this.readRunDetail(route, decodeURIComponent(detail[1]));
            return;
        }
        if (this.run && pathname.endsWith('/artifacts')) {
            this.successfulWrites.push({ path: pathname, authorization });
            await fulfillExecuteJsonResponse(route, {
                artifactSchemaVersion: 2,
                distributedRunId: this.run.distributedRunId,
                generatedAtEpochMs: 2_000_000_000_000,
                files: {
                    'distributed-run.json': JSON.stringify(this.run),
                    'manifest.json': JSON.stringify(this.run.manifest),
                    'control-run.json': JSON.stringify(this.base.runs[0])
                }
            });
            return;
        }
        await fulfillExecuteJsonResponse(route, { error: `Unhandled GET ${pathname}` }, 404);
    }

    private async serveRunWrite(route: Route, pathname: string, authorization: string | undefined): Promise<void> {
        const body = route.request().postDataJSON() as ExecuteManifestRequest | undefined;
        const failure = this.options.failure;
        if (failure && (pathname === failure.path || pathname.endsWith(failure.path))) {
            await fulfillExecuteJsonResponse(route, { error: failure.message }, failure.status);
            return;
        }
        if (pathname === '/distributed-runs/resolve-targets' && body?.manifest) {
            await this.resolveTargets(route, body.manifest);
            return;
        }
        if (pathname === '/distributed-runs' && body?.manifest) {
            await this.createRun(route, body.manifest);
            return;
        }
        const state = resolveLifecycleWriteState(pathname);
        if (this.run && state) {
            this.setRunState(state);
            if (state === 'waiting-for-ack') {
                this.waitingReads = 0;
            }
            if (state === 'running') {
                this.runningReads = 0;
            }
            this.successfulWrites.push({ path: pathname, authorization });
            await fulfillExecuteJsonResponse(route, this.run);
            return;
        }
        await fulfillExecuteJsonResponse(route, { error: `Unhandled POST ${pathname}` }, 404);
    }

    private async readSnapshot(route: Route): Promise<void> {
        this.runReads += 1;
        const snapshotRun = this.run;
        const responseBase = this.options.refreshAgentEvidence ? refreshControlAgentEvidence(this.base) : this.base;
        this.latestResponseBase = responseBase;
        if (this.shouldDeferNextRunRead) {
            this.shouldDeferNextRunRead = false;
            this.runReadStarted.resolve();
            await this.runReadGate.promise;
            await fulfillExecuteJsonResponse(route, {
                ...responseBase,
                distributedRuns: snapshotRun ? [snapshotRun] : responseBase.distributedRuns ?? []
            });
            return;
        }
        if (this.run?.state === 'waiting-for-ack' && this.waitingReads++ > 0) {
            this.setRunState('ready');
        }
        else if (this.run?.state === 'running' && this.runningReads++ > 0) {
            this.setRunState('passed');
        }
        await fulfillExecuteJsonResponse(route, {
            ...responseBase,
            distributedRuns: this.run ? [this.run] : responseBase.distributedRuns ?? []
        });
    }

    private async readRunDetail(route: Route, runId: string): Promise<void> {
        const detail = this.latestResponseBase.runs.find((candidate) => candidate.runId === runId);
        await fulfillExecuteJsonResponse(route, detail ?? { error: 'Control run not found.' }, detail ? 200 : 404);
    }

    private async issueAgentToken(route: Route, runId: string, agentId: string): Promise<void> {
        this.tokenRequests.push({ runId, agentId });
        const now = Date.now();
        this.base = withLaunchedControlAgent(this.base, createExecuteAgent(runId, agentId), now);
        await fulfillExecuteJsonResponse(route, {
            runId,
            agentId,
            token: `control-agent-${agentId}`,
            issuedAtEpochMs: now,
            expiresAtEpochMs: now + 60_000
        }, 201);
    }

    private async resolveTargets(route: Route, manifest: RallarBlackBoxDistributedRunManifest): Promise<void> {
        this.resolutionCalls += 1;
        if (this.options.deferResolution && this.resolutionCalls === 1) {
            this.resolutionStarted.resolve();
            await this.resolutionGate.promise;
        }
        this.successfulWrites.push({
            path: new URL(route.request().url()).pathname,
            authorization: route.request().headers().authorization,
            manifest
        });
        const resolution = targetResolution(
            manifest,
            this.options.resolutionTargetIds?.(this.resolutionCalls, manifest) ?? selectedAgentIds(manifest)
        );
        try {
            await fulfillExecuteJsonResponse(route, resolution);
        }
        catch {
            // A configuration change may abort the request before the fixture releases it.
        }
    }

    private async createRun(route: Route, manifest: RallarBlackBoxDistributedRunManifest): Promise<void> {
        if (this.createdRunIds.has(manifest.distributedRunId)) {
            await fulfillExecuteJsonResponse(route, {
                error: `Distributed run ${manifest.distributedRunId} already exists.`
            }, 409);
            return;
        }
        this.createdRunIds.add(manifest.distributedRunId);
        this.run = createExecuteRunSnapshot({ manifest, state: 'draft', updatedAtEpochMs: ++this.version });
        this.successfulWrites.push({
            path: new URL(route.request().url()).pathname,
            authorization: route.request().headers().authorization,
            manifest
        });
        await fulfillExecuteJsonResponse(
            route,
            this.options.createResponseDistributedRunId
                ? { ...this.run, distributedRunId: this.options.createResponseDistributedRunId }
                : this.run
        );
    }
}

export async function installExecuteControlFixture(
    context: BrowserContext,
    options: ExecuteControlFixture.Options = {}
): Promise<ExecuteControlFixture> {
    const control = new ExecuteControlFixture(options);
    await control.install(context);
    return control;
}

function resolveLifecycleWriteState(pathname: string): RallarBlackBoxDistributedRunState | undefined {
    if (pathname.endsWith('/stage')) {
        return 'waiting-for-ack';
    }
    if (pathname.endsWith('/start')) {
        return 'running';
    }
    if (pathname.endsWith('/cancel')) {
        return 'cancelled';
    }
    return undefined;
}

function withLaunchedControlAgent(
    base: ControlServerSnapshot,
    launchedAgent: ControlAgentSnapshot,
    now: number
): ControlServerSnapshot {
    const runId = launchedAgent.runId;
    const current = base.runs.find((candidate) => candidate.runId === runId);
    const launchedRun: ControlRunSnapshot = current
        ? {
            ...current,
            agents: [
                ...current.agents.filter((candidate) => candidate.agentId !== launchedAgent.agentId),
                launchedAgent
            ],
            updatedAtEpochMs: now
        }
        : {
            runId,
            createdAtEpochMs: now,
            updatedAtEpochMs: now,
            agents: [launchedAgent],
            commands: [],
            results: [],
            events: [],
            stats: [],
            reports: [],
            heartbeats: []
        };
    return { ...base, runs: [...base.runs.filter((candidate) => candidate.runId !== runId), launchedRun] };
}

function refreshControlAgentEvidence(
    snapshot: ControlServerSnapshot
): ControlServerSnapshot {
    const now = Date.now();
    return {
        ...snapshot,
        runs: snapshot.runs.map((run) => ({
            ...run,
            updatedAtEpochMs: now,
            agents: run.agents.map((agentSnapshot) => ({
                ...agentSnapshot,
                lastSeenAtEpochMs: now,
                lastHeartbeatAtEpochMs: now
            }))
        }))
    };
}

async function fulfillCorsPreflight(route: Route): Promise<void> {
    await route.fulfill({
        status: 204,
        headers: {
            'access-control-allow-origin': '*',
            'access-control-allow-methods': 'GET, POST, OPTIONS',
            'access-control-allow-headers': 'authorization, content-type, x-client-id'
        }
    });
}
