import { expect, test, type APIRequestContext, type TestInfo } from '@playwright/test';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { toRtcCaptureReadout } from '@shared-web/browser/connection/to-rtc-capture-readout.ts';
import type { GroupRef } from '@shared/api/group-types.ts';
import { toError } from '@shared/resilience/to-error.ts';

import { waitForHeadlessWorkerAgentRegistration } from '../../../apps/rallar-black-box/src/headless-worker-runtime.ts';
import { decodeRallarBlackBoxTestResult } from '../../../packages/shared-test/rallar-bb-test/composite-results.ts';
import { createRallarBlackBoxEnsureGroupCommands } from '../../../packages/shared-test/rallar-bb-test/fixtures/live-rtc-setup.ts';
import type { RallarBlackBoxTestCommand } from '../../../packages/shared-test/rallar-bb-test/rallar-black-box-test-contracts.ts';
import { LiveRtcControlClient } from './live-rtc-control-client.ts';
import {
    jsonRecord,
    optionalJsonArray,
    requiredJsonRecord,
    requiredString,
    type LiveRtcJsonRecord
} from './live-rtc-evidence-json.ts';

interface WorkerCaptureRun {
    readonly control: LiveRtcControlClient;
    readonly request: APIRequestContext;
    readonly runId: string;
    readonly agentPrefix: string;
    readonly group: GroupRef;
    readonly testInfo: TestInfo;
}

interface WorkerCaptureAgent {
    readonly agentId: string;
    readonly connection: string;
}

interface WorkerIssuedSession {
    readonly agentId: string;
    readonly clientId: string;
    readonly sessionId: string;
}

interface WorkerCapturePayload {
    readonly roomRef: GroupRef;
    readonly matrixId: string;
    readonly deliveryMode: 'direct';
    readonly content: string;
    readonly sequence: number;
}

interface WorkerCaptureSend {
    readonly agent: WorkerCaptureAgent;
    readonly targetSessionId: string;
    readonly payload: WorkerCapturePayload;
}

interface WorkerCaptureReceive {
    readonly agent: WorkerCaptureAgent;
    readonly senderSessionId: string;
    readonly receiverSessionId: string;
    readonly payload: WorkerCapturePayload;
}

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const apiBaseUrl = 'http://127.0.0.1:8080';
const headlessBaseUrl = 'http://127.0.0.1:5179';
const controlBaseUrl = 'http://127.0.0.1:5180';

namespace WorkerCaptureProcess {
    export interface Exit {
        readonly code: number | null;
        readonly signal: NodeJS.Signals | null;
    }
}

/** Owns only the existing worker CLI child and the observation of its final exit. */
class WorkerCaptureProcess {
    readonly child: ChildProcess;
    readonly exited: Promise<WorkerCaptureProcess.Exit>;
    #output = '';

    constructor(env: NodeJS.ProcessEnv) {
        this.child = spawn(path.join(repoRoot, 'node_modules/.bin/tsx'), [
            'apps/rallar-black-box/scripts/headless-worker.ts'
        ], { cwd: repoRoot, env });
        this.child.stdout?.on('data', (chunk) => this.#output += String(chunk));
        this.child.stderr?.on('data', (chunk) => this.#output += String(chunk));
        this.exited = new Promise((resolve, reject) => {
            this.child.once('error', reject);
            this.child.once('close', (code, signal) => resolve({ code, signal }));
        });
    }

    getOutput(): string {
        return this.#output;
    }

    async stop(): Promise<WorkerCaptureProcess.Exit> {
        if (this.child.exitCode !== null || this.child.signalCode !== null) {
            return await this.exited;
        }
        this.child.kill('SIGTERM');
        try {
            return await within(this.exited, 10_000, 'Worker did not release its browser after SIGTERM');
        }
        catch (error) {
            this.child.kill('SIGKILL');
            await this.exited;
            throw error;
        }
    }
}

test.describe('actual default headless worker HOST capture', () => {
    test.skip(
        process.env.RALLAR_BLACK_BOX_WORKER_CAPTURE !== '1',
        'Requires the owned worker-capture service configuration.'
    );

    for (const mode of ['native', 'off'] as const) {
        test(
            `applies HOST ${mode} with omitted RUN and delivers the exact scoped RTC payload`,
            async ({ request }, testInfo) => {
                const run = createDefaultWorkerCaptureRun(request, testInfo, mode);
                const worker = new WorkerCaptureProcess(createDefaultWorkerEnvironment(run, mode));
                const agents = [1, 2].map((ordinal) => ({
                    agentId: `${run.agentPrefix}-${String(ordinal).padStart(2, '0')}`,
                    connection: `worker-${ordinal}`
                }));
                const restoredSessions: WorkerIssuedSession[] = [];
                const captures: LiveRtcControlClient.CapturedConnection[] = [];
                const native: LiveRtcControlClient.NativeAcquisitionProof[] = [];
                let failure: Error | undefined;
                try {
                    for (const agent of agents) {
                        await waitForWorkerAgent(run, worker, agent);
                    }
                    const issuedSessions = await ensureWorkerMemberships(run, agents);
                    expect(new Set(issuedSessions.map((session) => session.sessionId)).size).toBe(2);
                    expect(new Set(issuedSessions.map((session) => session.clientId)).size).toBe(2);
                    for (const [index, agent] of agents.entries()) {
                        const capture = await connectWorkerAgent(run, agent, mode);
                        expect(capture.sessionId).toBe(issuedSessions[index].sessionId);
                        const restored = await readWorkerIssuedSession(run, agent, 'connected');
                        expect(restored).toEqual(issuedSessions[index]);
                        restoredSessions.push(restored);
                        captures.push(capture);
                    }
                    expect(new Set(captures.map((capture) => capture.sessionId)).size).toBe(2);
                    for (const capture of captures) {
                        if (mode === 'native') {
                            native.push(
                                await run.control.readRtcNativeAcquisition(capture).then((result) =>
                                    result.fold(
                                        (refused) => {
                                            throw new Error(`Native acquisition refused: ${refused.reason}`);
                                        },
                                        (proof) => proof
                                    )
                                )
                            );
                        }
                        else {
                            expect(capture.receipt).toMatchObject({
                                nativeScopeId: { status: 'unavailable', reason: 'not-applicable' },
                                nativeAvailability: { status: 'unavailable', reason: 'disabled' },
                                nativeCoverage: 'not-applicable'
                            });
                        }
                    }
                    const payload: WorkerCapturePayload = {
                        roomRef: { ...run.group },
                        matrixId: run.runId,
                        deliveryMode: 'direct',
                        content: 'HOST exact RTC receive',
                        sequence: 1
                    };
                    await sendWorkerPayload(run, { agent: agents[0], targetSessionId: captures[1].sessionId, payload });
                    const received = await readWorkerReceive(run, {
                        agent: agents[1],
                        senderSessionId: captures[0].sessionId,
                        receiverSessionId: captures[1].sessionId,
                        payload
                    });
                    await writeEvidence(run, 'capture-and-receive.json', {
                        issuedSessions,
                        restoredSessions,
                        captures,
                        native,
                        received
                    });
                }
                catch (error) {
                    failure = toError(error);
                    throw failure;
                }
                finally {
                    const exit = await retireWorkerRun(run, worker, failure);
                    if (failure === undefined) {
                        expect(exit).toEqual({ code: 0, signal: null });
                    }
                }
            }
        );
    }

    test('refuses malformed HOST before acquiring a usable agent', async ({ request }, testInfo) => {
        const run = createDefaultWorkerCaptureRun(request, testInfo, 'malformed');
        const worker = new WorkerCaptureProcess(createDefaultWorkerEnvironment(run, 'Native'));
        let failure: Error | undefined;
        try {
            const exited = await within(worker.exited, 10_000, 'Malformed HOST did not refuse startup');
            expect(exited).toEqual({ code: 1, signal: null });
            expect(worker.getOutput()).toContain('RALLAR_BLACK_BOX_RTC_CAPTURE_MODE');
            expect(worker.getOutput()).not.toContain('Opening agent');
            const response = await request.get(`${controlBaseUrl}/runs/${encodeURIComponent(run.runId)}`);
            expect(response.status()).toBe(404);
            await writeEvidence(run, 'startup-refusal.json', { exited, controlRunStatus: response.status() });
        }
        catch (error) {
            failure = toError(error);
            throw failure;
        }
        finally {
            await retireWorkerRun(run, worker, failure);
        }
    });
});

function createDefaultWorkerCaptureRun(
    request: APIRequestContext,
    testInfo: TestInfo,
    label: string
): WorkerCaptureRun {
    const identity = `worker-host-${label}-${crypto.randomUUID()}`;
    return {
        request,
        testInfo,
        runId: identity,
        agentPrefix: identity,
        group: { applicationId: 'rallar-server', workspaceId: 'default', groupId: identity },
        control: new LiveRtcControlClient({
            request,
            baseUrl: controlBaseUrl,
            monotonicNow: () => performance.now(),
            epochNow: Date.now
        })
    };
}

function createDefaultWorkerEnvironment(run: WorkerCaptureRun, mode: string): NodeJS.ProcessEnv {
    return {
        ...process.env,
        RALLAR_BLACK_BOX_SPA_URL: headlessBaseUrl,
        RALLAR_BLACK_BOX_CONTROL_URL: `${controlBaseUrl}/control`,
        RALLAR_CONTROL_HTTP_URL: controlBaseUrl,
        RALLAR_API_BASE_URL: apiBaseUrl,
        RALLAR_BLACK_BOX_RUN_ID: run.runId,
        RALLAR_BLACK_BOX_ROOM_ID: run.group.groupId,
        RALLAR_BLACK_BOX_APPLICATION_ID: run.group.applicationId,
        RALLAR_BLACK_BOX_WORKSPACE_ID: run.group.workspaceId,
        RALLAR_BLACK_BOX_AGENT_COUNT: '2',
        RALLAR_BLACK_BOX_AGENT_PREFIX: run.agentPrefix,
        RALLAR_BLACK_BOX_AGENT_START_INDEX: '1',
        RALLAR_BLACK_BOX_AGENT_1_USERNAME: `${run.agentPrefix}-user-1`,
        RALLAR_BLACK_BOX_AGENT_1_PASSWORD: crypto.randomUUID(),
        RALLAR_BLACK_BOX_AGENT_2_USERNAME: `${run.agentPrefix}-user-2`,
        RALLAR_BLACK_BOX_AGENT_2_PASSWORD: crypto.randomUUID(),
        RALLAR_BLACK_BOX_REGISTER: 'true',
        RALLAR_BLACK_BOX_RESTORE_SESSION: 'true',
        RALLAR_BLACK_BOX_RTC_CAPTURE_MODE: mode,
        RALLAR_BLACK_BOX_HEADLESS_ENTRY: 'headless',
        RALLAR_BLACK_BOX_HEADLESS: 'true',
        RALLAR_BLACK_BOX_EXIT_MODE: 'signal'
    };
}

async function waitForWorkerAgent(
    run: WorkerCaptureRun,
    worker: WorkerCaptureProcess,
    agent: WorkerCaptureAgent
): Promise<void> {
    await waitForHeadlessWorkerAgentRegistration({
        agentId: agent.agentId,
        timeoutMs: 45_000,
        pollIntervalMs: 500,
        fetchSnapshot: async (signal) => {
            const response = await fetch(`${controlBaseUrl}/runs/${encodeURIComponent(run.runId)}`, { signal });
            if (!response.ok) {
                throw new Error(`Worker registration snapshot HTTP ${response.status}`);
            }
            return await response.json();
        },
        readAgentPageStatus: async () => worker.getOutput(),
        sleep: async (ms) => await new Promise((resolve) => setTimeout(resolve, ms)),
        now: Date.now
    });
}

async function ensureWorkerMemberships(
    run: WorkerCaptureRun,
    agents: readonly WorkerCaptureAgent[]
): Promise<readonly WorkerIssuedSession[]> {
    const issuedSessions: WorkerIssuedSession[] = [];
    for (const [index, agent] of agents.entries()) {
        const [createGroup, addMembership] = createRallarBlackBoxEnsureGroupCommands({
            commandPrefix: agent.agentId,
            requestPrefix: agent.agentId,
            group: run.group,
            actor: '{auth.clientId}'
        });
        if (index === 0) {
            const created = await run.control.executeOk({
                runId: run.runId,
                agentId: agent.agentId,
                commandId: createGroup.commandId!,
                command: createGroup
            });
            expect(run.control.resultValue(created).status).toBe(201);
        }
        const added = await run.control.executeOk({
            runId: run.runId,
            agentId: agent.agentId,
            commandId: addMembership.commandId!,
            command: addMembership
        });
        const value = run.control.resultValue(added);
        expect([200, 201]).toContain(value.status);
        const session = await readWorkerIssuedSession(run, agent, 'authenticated');
        const snapshot = jsonRecord(value.body);
        expect(snapshot?.group).toMatchObject(run.group);
        const members = optionalJsonArray(snapshot?.members, '$.membership.members');
        expect(members.some((entry) => {
            const member = jsonRecord(entry);
            return member?.principalId === session.clientId && member.status === 'active';
        })).toBe(true);
        issuedSessions.push(session);
    }
    return issuedSessions;
}

async function readWorkerIssuedSession(
    run: WorkerCaptureRun,
    agent: WorkerCaptureAgent,
    phase: 'authenticated' | 'connected'
): Promise<WorkerIssuedSession> {
    const result = await run.control.executeOk({
        runId: run.runId,
        agentId: agent.agentId,
        commandId: `health-${phase}-${agent.agentId}`,
        command: { kind: 'health' }
    });
    const rallar = jsonRecord(run.control.resultValue(result).rallar);
    const session = jsonRecord(rallar?.session);
    const sessionId = session?.sessionId;
    const clientId = session?.clientId;
    if (typeof sessionId !== 'string' || sessionId.length === 0) {
        throw new Error(`Health ${phase} did not return an issued session for ${agent.agentId}`);
    }
    if (typeof clientId !== 'string' || clientId.length === 0) {
        throw new Error(`Health ${phase} did not return an authenticated client for ${agent.agentId}`);
    }
    return { agentId: agent.agentId, clientId, sessionId };
}

async function connectWorkerAgent(
    run: WorkerCaptureRun,
    agent: WorkerCaptureAgent,
    mode: 'native' | 'off'
): Promise<LiveRtcControlClient.CapturedConnection> {
    const commandId = `connect-${agent.agentId}`;
    const connected = await executeWorkerRecipe(run, agent, {
        kind: 'rtc.connect',
        commandId,
        connection: agent.connection,
        actor: agent.agentId,
        roomId: run.group.groupId,
        applicationId: run.group.applicationId,
        workspaceId: run.group.workspaceId,
        roomRef: { ...run.group },
        transport: 'realtime',
        rallar: { apiBaseUrl, restoreSession: true, logoutOnClose: false, leaveRoomOnClose: false },
        timeoutMs: 45_000
    });
    return toWorkerCapturedConnection(run, agent, { ...connected, mode, commandId });
}

interface WorkerRecipeResult {
    readonly connected: LiveRtcJsonRecord;
    readonly recipeAttribution: LiveRtcControlClient.RecipeAttribution;
}

interface WorkerConnectResult extends WorkerRecipeResult {
    readonly mode: 'native' | 'off';
    readonly commandId: string;
}

function toWorkerCapturedConnection(
    run: WorkerCaptureRun,
    agent: WorkerCaptureAgent,
    result: WorkerConnectResult
): LiveRtcControlClient.CapturedConnection {
    const { connected, mode, commandId } = result;
    const value = jsonRecord(connected.value);
    const readout = toRtcCaptureReadout(value?.rtcCapture).fold(
        (reason) => {
            throw new Error(`Capture receipt refused: ${reason}`);
        },
        (observed) => observed
    );
    if (readout.status !== 'observed') {
        throw new Error(`Capture receipt unavailable: ${readout.reason}`);
    }
    expect(readout.value.configuration).toEqual({ mode, origin: 'host' });
    expect(readout.value.application).toEqual({ status: 'applied', mode });
    expect(readout.value.connectionId.status).toBe('observed');
    expect(typeof value?.sessionId).toBe('string');
    if (typeof value?.sessionId !== 'string' || value.sessionId.length === 0) {
        throw new Error('Connect did not return an issued session');
    }
    return {
        runId: run.runId,
        agentId: agent.agentId,
        commandId,
        connection: agent.connection,
        transport: 'realtime',
        sessionId: value.sessionId,
        requestedConfiguration: { mode, origin: 'host' },
        receipt: readout.value,
        recipeAttribution: result.recipeAttribution
    };
}

async function executeWorkerRecipe(
    run: WorkerCaptureRun,
    agent: WorkerCaptureAgent,
    command: RallarBlackBoxTestCommand
): Promise<WorkerRecipeResult> {
    const rootCommandId = `recipe-${requiredString(command.commandId, '$.command.commandId')}`;
    const recipe = { schemaVersion: 1 as const, recipeId: rootCommandId, commands: [command] };
    const result = await run.control.executeOk({
        runId: run.runId,
        agentId: agent.agentId,
        commandId: rootCommandId,
        command: {
            kind: 'recipe.run',
            recipe
        },
        timeoutMs: 60_000
    });
    expect(result.commandId).toBe(rootCommandId);
    expect(result.agentId).toBe(agent.agentId);
    const acknowledged = run.control.resultValue(result);
    expect(acknowledged.recipeId).toBe(recipe.recipeId);
    const invocation = requiredJsonRecord(acknowledged.invocation, '$.recipe.invocation');
    const results = optionalJsonArray(acknowledged.results, '$.recipe.results');
    const child = jsonRecord(results[0]);
    expect(child?.ok).toBe(true);
    expect(child?.commandId).toBe(command.commandId);
    if (!child) {
        throw new Error('Recipe returned no child result');
    }
    const decoded = decodeRallarBlackBoxTestResult(child).fold(
        (issues) => {
            throw new Error(`Recipe child result refused: ${issues.join(', ')}`);
        },
        (connected) => connected
    );
    expect(decoded.kind).toBe(command.kind);
    expect(decoded.status).toBe('ok');
    expect(decoded.replayed).not.toBe(true);
    return {
        connected: child,
        recipeAttribution: {
            rootCommandId,
            recipeId: recipe.recipeId,
            invocationId: requiredString(invocation.invocationId, '$.recipe.invocation.invocationId'),
            recipeBodyId: requiredString(invocation.recipeBodyId, '$.recipe.invocation.recipeBodyId'),
            childIndex: 0
        }
    };
}

async function sendWorkerPayload(run: WorkerCaptureRun, send: WorkerCaptureSend): Promise<void> {
    await executeWorkerRecipe(run, send.agent, {
        kind: 'rtc.send',
        commandId: `send-${send.agent.agentId}`,
        connection: send.agent.connection,
        applicationId: run.group.applicationId,
        workspaceId: run.group.workspaceId,
        roomRef: { ...run.group },
        transport: 'realtime',
        timeoutMs: 60_000,
        send: { roomId: run.group.groupId, peerIds: [send.targetSessionId], openTimeoutMs: 20_000, data: send.payload }
    });
}

async function readWorkerReceive(
    run: WorkerCaptureRun,
    receive: WorkerCaptureReceive
): Promise<LiveRtcControlClient.Event | undefined> {
    await run.control.waitForMessage({
        runId: run.runId,
        senderAgentId: `${run.agentPrefix}-01`,
        agentId: receive.agent.agentId,
        transport: 'realtime',
        matrixId: run.runId,
        deliveryMode: 'direct',
        startedAtMs: performance.now()
    });
    const snapshot = await run.control.fetchRun(run.runId);
    const event = snapshot.events.find((candidate) => {
        const runtime = jsonRecord(candidate.payload);
        return candidate.agentId === receive.agent.agentId && runtime?.kind === 'message' &&
            runtime.topic === 'rallar.browser.realtime.message';
    });
    const runtime = jsonRecord(event?.payload);
    const received = jsonRecord(runtime?.payload);
    expect(runtime?.transport).toBe('realtime');
    expect(received?.data).toEqual(receive.payload);
    expect(received).toMatchObject({
        roomRef: run.group,
        remotePeerId: receive.senderSessionId,
        peerId: receive.receiverSessionId
    });
    return event;
}

async function writeEvidence(run: WorkerCaptureRun, name: string, value: object): Promise<void> {
    const output = run.testInfo.outputPath(name);
    await mkdir(path.dirname(output), { recursive: true });
    await writeFile(output, JSON.stringify(value, null, 2));
    await run.testInfo.attach(name, { path: output, contentType: 'application/json' });
}

async function retireWorkerRun(
    run: WorkerCaptureRun,
    worker: WorkerCaptureProcess,
    originalFailure: Error | undefined
): Promise<WorkerCaptureProcess.Exit> {
    const cleanup = await Promise.allSettled([
        worker.stop(),
        run.request.get(`${controlBaseUrl}/runs/${encodeURIComponent(run.runId)}/artifacts`).then(async (response) => {
            if (response.ok()) {
                await writeEvidence(run, 'control-artifact-bundle.json', await response.json());
            }
        }),
        run.request.get(`${controlBaseUrl}/runs/${encodeURIComponent(run.runId)}/events.jsonl`).then(
            async (response) => {
                if (response.ok()) {
                    await writeFile(run.testInfo.outputPath('recorder-events.jsonl'), await response.text());
                }
            }
        )
    ]);
    await writeEvidence(run, 'worker-resource-close.json', {
        exit: cleanup[0].status === 'fulfilled' ? cleanup[0].value : null,
        output: worker.getOutput()
    });
    const failures = cleanup.filter((outcome) => outcome.status === 'rejected').map((outcome) => outcome.reason);
    if (failures.length > 0) {
        throw new AggregateError(
            originalFailure === undefined ? failures : [originalFailure, ...failures],
            'Worker capture cleanup failed',
            { cause: originalFailure }
        );
    }
    if (originalFailure === undefined) {
        expect(worker.getOutput()).toContain('Rallar black-box headless worker stopped.');
    }
    if (cleanup[0].status !== 'fulfilled') {
        throw new Error('Worker exit was not observed');
    }
    return cleanup[0].value;
}

async function within<T>(operation: Promise<T>, timeoutMs: number, message: string): Promise<T> {
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
        return await Promise.race([
            operation,
            new Promise<T>((_resolve, reject) => {
                timeout = setTimeout(() => reject(new Error(message)), timeoutMs);
            })
        ]);
    }
    finally {
        clearTimeout(timeout);
    }
}
