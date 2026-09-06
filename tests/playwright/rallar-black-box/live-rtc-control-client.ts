import {
    expect,
    type APIRequestContext,
    type BrowserContext,
    type Page,
    type TestInfo
} from '@playwright/test';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import { toError } from '@shared/resilience/to-error.ts';

import type { RtcBaselineJson } from '../../../packages/shared-rtc-bench/baseline/contracts/rtc-baseline-contracts.ts';
import type { BlackBoxRallarRuntime } from '../../../packages/shared-test/black-box-runner/browser/rallar-browser-runtime/black-box-rallar-runtime-contract.ts';
import type { RallarBlackBoxTestCommand } from '../../../packages/shared-test/rallar-bb-test/types.ts';

import {
    buildLiveRtcAgentDiagnostics,
    type LiveRtcAgentDiagnostics
} from './live-rtc-agent-diagnostics.ts';
import {
    jsonRecord,
    normalizeJson,
    optionalJsonArray,
    optionalString,
    requiredBoolean,
    requiredJsonRecord,
    requiredString,
    stringArrayValue,
    stringValue,
    type LiveRtcJsonRecord
} from './live-rtc-evidence-json.ts';
import type { LiveRtcDiagnosticsCheckpoint } from './live-rtc-performance-evidence.ts';

export namespace LiveRtcControlClient {
    export interface FormationAgent {
        readonly prefix: 'A' | 'B' | 'C';
        readonly agentId: string;
        readonly actor: string;
        readonly connection: string;
        readonly refreshRoom: BlackBoxRallarRuntime['refreshRoom'];
    }

    export interface UnexpectedDeliveryInput {
        readonly runId: string;
        readonly scenarios: readonly LiveRtcControlClient.DeliveryScenario[];
    }

    export interface ArtifactBundleInput {
        readonly runId: string;
        readonly commandIds: readonly string[];
    }

    export interface RunSummaryInput {
        readonly testInfo: TestInfo;
        readonly runId: string;
    }

    export interface ReceivedNackInput {
        readonly testInfo: Pick<TestInfo, 'attach'>;
        readonly runId: string;
        readonly agentId: string;
        readonly messageId: string;
        readonly senderSessionId: string;
        readonly targetSessionId: string;
        readonly frames: readonly string[];
    }

    export interface Dependencies {
        readonly request: APIRequestContext;
        readonly baseUrl: string;
        readonly diagnosticsOutDir?: string;
        readonly monotonicNow: () => number;
        readonly epochNow: () => number;
    }

    export interface Agent extends FormationAgent {
        context: Pick<BrowserContext, 'close'>;
        page: Page;
    }

    export interface Result {
        agentId?: string;
        commandId: string;
        ok: boolean;
        result?: Readonly<{ value?: RtcBaselineJson; }>;
        error?: RtcBaselineJson;
    }

    export interface Event {
        kind?: string;
        agentId?: string;
        payload?: RtcBaselineJson;
    }

    export interface RunSnapshot {
        agents: readonly Readonly<{ agentId: string; }>[];
        results: readonly Result[];
        events: readonly Event[];
    }

    export interface DeliveryScenario {
        matrixId: string;
        transport: 'realtime' | 'messages.rtc';
        deliveryMode: 'direct' | 'multicast' | 'broadcast';
        senderAgentId: string;
        expectedAgentIds: readonly string[];
        allowedAgentIds: readonly string[];
    }

    export interface ExecuteInput {
        runId: string;
        agentId: string;
        commandId: string;
        command: RallarBlackBoxTestCommand;
        timeoutMs?: number;
    }

    export interface WaitForMessageInput {
        runId: string;
        agentId: string;
        transport: 'realtime' | 'messages.rtc';
        matrixId: string;
        deliveryMode: string;
        startedAtMs: number;
    }

    export interface WaitForPeerReadinessInput {
        runId: string;
        agent: Pick<FormationAgent, 'agentId' | 'prefix' | 'refreshRoom'>;
        expectedPeerIds: readonly string[];
        suffix: string;
        startedAtMs: number;
    }

    export interface WaitForPeerAbsenceInput {
        runId: string;
        agent: Pick<FormationAgent, 'agentId' | 'prefix'>;
        departedPeerIds: readonly string[];
        suffix: string;
    }

    export interface CaptureDiagnosticsInput {
        testInfo: TestInfo;
        runId: string;
        agents: readonly Agent[];
        label: string;
        cycle: number | null;
    }

    export interface CapturedDiagnostics {
        commandIds: readonly string[];
        checkpoint: LiveRtcDiagnosticsCheckpoint;
    }
}

export class LiveRtcControlClient {
    readonly #request: APIRequestContext;
    readonly #baseUrl: string;
    readonly #diagnosticsOutDir: string | undefined;
    readonly #monotonicNow: () => number;
    readonly #epochNow: () => number;

    constructor(input: LiveRtcControlClient.Dependencies) {
        this.#request = input.request;
        this.#baseUrl = input.baseUrl;
        this.#diagnosticsOutDir = input.diagnosticsOutDir;
        this.#monotonicNow = input.monotonicNow;
        this.#epochNow = input.epochNow;
    }

    async fetchRun(runId: string): Promise<LiveRtcControlClient.RunSnapshot> {
        const response = await this.#request.get(
            `${this.#baseUrl}/runs/${encodeURIComponent(runId)}`
        );
        expect(response.ok()).toBe(true);
        return decodeControlRunSnapshot(normalizeJson(await response.json()));
    }

    async executeResult(
        input: LiveRtcControlClient.ExecuteInput
    ): Promise<LiveRtcControlClient.Result> {
        const response = await this.#request.post(
            `${this.#baseUrl}/runs/${encodeURIComponent(input.runId)}/agents/${
                encodeURIComponent(input.agentId)
            }/commands`,
            {
                data: {
                    commandId: input.commandId,
                    command: input.command
                }
            }
        );
        expect(
            response.status(),
            `Expected command ${input.commandId} for agent ${input.agentId} to enqueue: ${await response.text()}`
        ).toBe(202);

        let latest: LiveRtcControlClient.Result | undefined;
        await expect.poll(async () => {
            const run = await this.fetchRun(input.runId);
            latest = run.results.find(
                (result) => result.commandId === input.commandId
            );
            return Boolean(latest);
        }, {
            timeout: input.timeoutMs ?? 45_000
        }).toBe(true);
        if (!latest) {
            throw new Error(`Command ${input.commandId} did not return a result.`);
        }
        return latest;
    }

    async executeOk(
        input: LiveRtcControlClient.ExecuteInput
    ): Promise<LiveRtcControlClient.Result> {
        const result = await this.executeResult(input);
        expect(
            result.ok,
            `Expected command ${input.commandId} for agent ${input.agentId} to succeed: ${JSON.stringify(result)}`
        ).toBe(true);
        return result;
    }

    resultValue(
        result: LiveRtcControlClient.Result
    ): LiveRtcJsonRecord {
        return jsonRecord(result.result?.value) ?? {};
    }

    requireSessionId(
        result: LiveRtcControlClient.Result,
        commandId: string
    ): string {
        const sessionId = stringValue(this.resultValue(result).sessionId);
        if (!sessionId) {
            throw new Error(`Connect result ${commandId} did not include a sessionId.`);
        }
        return sessionId;
    }

    requireSentMessageId(result: LiveRtcControlClient.Result): string {
        const sendResult = jsonRecord(this.resultValue(result).message);
        const sentMessage = jsonRecord(sendResult?.message);
        const messageId = stringValue(jsonRecord(sentMessage?.id)?.msgId);
        if (!messageId) {
            throw new Error('RTC send result did not include a message ID.');
        }
        return messageId;
    }

    readyPeerIds(result: LiveRtcControlClient.Result): readonly string[] {
        return stringArrayValue(
            jsonRecord(
                jsonRecord(this.resultValue(result).rallar)?.rtcStatus
            )?.readyPeerIds
        );
    }

    runtimeTopics(run: LiveRtcControlClient.RunSnapshot): readonly string[] {
        return run.events
            .map((event) => stringValue(runtimeEventPayload(event).topic))
            .filter((topic): topic is string => Boolean(topic));
    }

    async waitForMessage(
        input: LiveRtcControlClient.WaitForMessageInput
    ): Promise<number> {
        await expect.poll(async () => {
            const run = await this.fetchRun(input.runId);
            return run.events.some((event) => isMessageFor(event, input));
        }, {
            message: `Expected ${input.agentId} to receive ${input.transport} ${input.deliveryMode} ${input.matrixId}`,
            timeout: 60_000
        }).toBe(true);
        return this.#monotonicNow() - input.startedAtMs;
    }

    async waitForPeerReadiness(
        input: LiveRtcControlClient.WaitForPeerReadinessInput
    ): Promise<number> {
        const deadlineMs = this.#monotonicNow() + 60_000;
        let attempt = 0;
        try {
            await expect.poll(async () => {
                const refreshTimeoutMs = deadlineMs - this.#monotonicNow();
                if (refreshTimeoutMs <= 0) {
                    throw new Error(`RTC room refresh for ${input.agent.agentId} exceeded the readiness deadline.`);
                }
                await input.agent.refreshRoom({ timeoutMs: refreshTimeoutMs });
                const healthTimeoutMs = Math.min(15_000, deadlineMs - this.#monotonicNow());
                if (healthTimeoutMs <= 0) {
                    throw new Error(`RTC room refresh for ${input.agent.agentId} exceeded the readiness deadline.`);
                }
                const result = await this.executeResult({
                    runId: input.runId,
                    agentId: input.agent.agentId,
                    commandId: `health-ready-${input.agent.prefix.toLowerCase()}-${input.suffix}-${attempt++}`,
                    command: { kind: 'health' },
                    timeoutMs: healthTimeoutMs
                }).catch(() => undefined);
                if (!result?.ok) {
                    return [];
                }
                return stringArrayValue(
                    jsonRecord(
                        jsonRecord(this.resultValue(result).rallar)?.rtcStatus
                    )?.readyPeerIds
                );
            }, {
                message: `Expected ${input.agent.agentId} to see ready peers ${
                    input.expectedPeerIds.join(', ')
                } for ${input.suffix}`,
                timeout: 60_000
            }).toEqual(expect.arrayContaining([...input.expectedPeerIds]));
        }
        catch (cause) {
            try {
                await this.#recordReadinessFailure(input, attempt, toError(cause));
            }
            catch (diagnosticCause) {
                console.error('Failed to record RTC readiness diagnostics', toError(diagnosticCause));
            }
            throw cause;
        }
        const readyAtMs = this.#monotonicNow();
        if (readyAtMs >= deadlineMs) {
            throw new Error(`RTC room refresh for ${input.agent.agentId} exceeded the readiness deadline.`);
        }
        return readyAtMs - input.startedAtMs;
    }

    async #recordReadinessFailure(
        input: LiveRtcControlClient.WaitForPeerReadinessInput,
        attempt: number,
        failure: Error
    ): Promise<void> {
        if (!this.#diagnosticsOutDir) {
            return;
        }
        const health = await this.executeResult({
            runId: input.runId,
            agentId: input.agent.agentId,
            commandId: `health-readiness-failure-${input.agent.prefix.toLowerCase()}-${input.suffix}-${attempt}`,
            command: { kind: 'health', includeRtcDiagnostics: true },
            timeoutMs: 15_000
        });
        await this.#writeDiagnosticsArtifact(
            `live-rtc-readiness-failure-${safeFileName(input.agent.agentId)}-${safeFileName(input.suffix)}.json`,
            JSON.stringify(
                {
                    runId: input.runId,
                    agentId: input.agent.agentId,
                    expectedPeerIds: input.expectedPeerIds,
                    capturedAtEpochMs: this.#epochNow(),
                    failure: { name: failure.name, message: failure.message },
                    health
                },
                null,
                2
            )
        );
    }

    async waitForPeerAbsence(
        input: LiveRtcControlClient.WaitForPeerAbsenceInput
    ): Promise<void> {
        let attempt = 0;
        await expect.poll(async () => {
            const result = await this.executeResult({
                runId: input.runId,
                agentId: input.agent.agentId,
                commandId: `health-absent-${input.agent.prefix.toLowerCase()}-${input.suffix}-${attempt++}`,
                command: { kind: 'health' },
                timeoutMs: 15_000
            }).catch(() => undefined);
            if (!result?.ok) {
                return input.departedPeerIds;
            }
            const readyPeerIds = this.readyPeerIds(result);
            return input.departedPeerIds.filter((peerId) => readyPeerIds.includes(peerId));
        }, {
            message: `Expected ${input.agent.agentId} to observe departed peers ${
                input.departedPeerIds.join(', ')
            } for ${input.suffix}`,
            timeout: 60_000
        }).toEqual([]);
    }

    async unexpectedDeliveryCount(
        input: LiveRtcControlClient.UnexpectedDeliveryInput
    ): Promise<number> {
        const run = await this.fetchRun(input.runId);
        return countUnexpectedLiveRtcDeliveries({
            events: run.events,
            scenarios: input.scenarios
        });
    }

    async expectArtifactBundle(
        input: LiveRtcControlClient.ArtifactBundleInput
    ): Promise<void> {
        const response = await this.#request.get(
            `${this.#baseUrl}/runs/${encodeURIComponent(input.runId)}/artifacts`
        );
        expect(response.ok()).toBe(true);
        const bundle = requiredJsonRecord(
            normalizeJson(await response.json()),
            '$.artifactBundle'
        );
        const files = requiredJsonRecord(bundle.files, '$.artifactBundle.files');
        const report = stringValue(files['report.json']) ?? '';
        const events = stringValue(files['events.jsonl']) ?? '';
        expect(report).toContain(input.commandIds[0]);
        expect(events).toContain('rallar.browser');
    }

    async attachRunSummary(
        input: LiveRtcControlClient.RunSummaryInput
    ): Promise<void> {
        const run = await this.fetchRun(input.runId);
        const body = JSON.stringify(
            {
                runId: input.runId,
                agents: run.agents.map((agent) => agent.agentId),
                resultCount: run.results.length,
                eventCount: run.events.length
            },
            null,
            2
        );
        await input.testInfo.attach('live-rtc-three-browser-run-summary.json', {
            body,
            contentType: 'application/json'
        });
        await this.#writeDiagnosticsArtifact(
            `live-rtc-three-browser-run-summary-${safeFileName(input.runId)}.json`,
            body
        );
    }

    async captureDiagnostics(
        input: LiveRtcControlClient.CaptureDiagnosticsInput
    ): Promise<LiveRtcControlClient.CapturedDiagnostics> {
        const commandIds: string[] = [];
        const agents: LiveRtcAgentDiagnostics[] = [];
        for (const agent of input.agents) {
            const commandId = `rtc-diagnostics-${agent.prefix.toLowerCase()}-${input.label}`;
            commandIds.push(commandId);
            const result = await this.executeOk({
                runId: input.runId,
                agentId: agent.agentId,
                commandId,
                command: {
                    kind: 'health',
                    includeRtcDiagnostics: true
                },
                timeoutMs: 30_000
            });
            agents.push(
                buildLiveRtcAgentDiagnostics(agent.agentId, this.resultValue(result))
            );
        }
        const checkpoint: LiveRtcDiagnosticsCheckpoint = {
            label: input.label,
            cycle: input.cycle,
            agents
        };
        const body = JSON.stringify(
            {
                runId: input.runId,
                capturedAtEpochMs: this.#epochNow(),
                ...checkpoint
            },
            null,
            2
        );
        await input.testInfo.attach(`live-rtc-diagnostics-${input.label}.json`, {
            body,
            contentType: 'application/json'
        });
        await this.#writeDiagnosticsArtifact(
            `live-rtc-diagnostics-${safeFileName(input.label)}.json`,
            body
        );
        return { commandIds, checkpoint };
    }

    async #writeDiagnosticsArtifact(fileName: string, body: string): Promise<void> {
        if (!this.#diagnosticsOutDir) {
            return;
        }
        await mkdir(this.#diagnosticsOutDir, { recursive: true });
        await writeFile(resolve(this.#diagnosticsOutDir, fileName), body);
    }

    async recordReceivedNack(
        input: LiveRtcControlClient.ReceivedNackInput
    ): Promise<void> {
        const { testInfo, ...evidence } = input;
        const body = JSON.stringify({ observation: 'received-protocol-nack', ...evidence }, null, 2);
        const fileName = `live-rtc-received-nack-${safeFileName(input.agentId)}.json`;
        await testInfo.attach(fileName, { body, contentType: 'application/json' });
        await this.#writeDiagnosticsArtifact(fileName, body);
    }
}

function decodeControlRunSnapshot(
    value: RtcBaselineJson
): LiveRtcControlClient.RunSnapshot {
    const run = requiredJsonRecord(value, '$.controlRun');
    const agents = optionalJsonArray(run.agents, '$.controlRun.agents').map(
        (entry, index) => {
            const agent = requiredJsonRecord(entry, `$.controlRun.agents[${index}]`);
            return {
                agentId: requiredString(
                    agent.agentId,
                    `$.controlRun.agents[${index}].agentId`
                )
            };
        }
    );
    const results = optionalJsonArray(run.results, '$.controlRun.results').map(
        (entry, index) => {
            const result = requiredJsonRecord(entry, `$.controlRun.results[${index}]`);
            const resultEnvelope = result.result === undefined
                ? null
                : requiredJsonRecord(
                    result.result,
                    `$.controlRun.results[${index}].result`
                );
            return {
                agentId: optionalString(
                    result.agentId,
                    `$.controlRun.results[${index}].agentId`
                ),
                commandId: requiredString(
                    result.commandId,
                    `$.controlRun.results[${index}].commandId`
                ),
                ok: requiredBoolean(
                    result.ok,
                    `$.controlRun.results[${index}].ok`
                ),
                ...(resultEnvelope ? { result: { value: resultEnvelope.value } } : {}),
                ...(result.error !== undefined ? { error: result.error } : {})
            };
        }
    );
    const events = optionalJsonArray(run.events, '$.controlRun.events').map(
        (entry, index) => {
            const event = requiredJsonRecord(entry, `$.controlRun.events[${index}]`);
            return {
                kind: optionalString(event.kind, `$.controlRun.events[${index}].kind`),
                agentId: optionalString(
                    event.agentId,
                    `$.controlRun.events[${index}].agentId`
                ),
                ...(event.payload !== undefined ? { payload: event.payload } : {})
            };
        }
    );
    return { agents, results, events };
}

function runtimeEventPayload(
    event: LiveRtcControlClient.Event
): LiveRtcJsonRecord {
    const payload = jsonRecord(event.payload) ?? {};
    return typeof payload.kind === 'string'
        ? payload
        : jsonRecord(payload.payload) ?? payload;
}

function messageData(
    event: LiveRtcControlClient.Event
): LiveRtcJsonRecord {
    const runtimeEvent = runtimeEventPayload(event);
    const runtimePayload = jsonRecord(runtimeEvent.payload) ?? {};
    return jsonRecord(runtimePayload.data ?? runtimeEvent.data) ?? {};
}

export interface LiveRtcObservedDeliveries {
    readonly events: readonly LiveRtcControlClient.Event[];
    readonly scenarios: readonly LiveRtcControlClient.DeliveryScenario[];
}

export function countUnexpectedLiveRtcDeliveries(
    input: LiveRtcObservedDeliveries
): number {
    const scenarioById = new Map(
        input.scenarios.map((scenario) => [scenario.matrixId, scenario])
    );
    return input.events.filter((event) => {
        const matrixId = stringValue(messageData(event).matrixId);
        const scenario = matrixId ? scenarioById.get(matrixId) : undefined;
        return scenario !== undefined &&
            event.agentId !== undefined &&
            !scenario.allowedAgentIds.includes(event.agentId);
    }).length;
}

function isMessageFor(
    event: LiveRtcControlClient.Event,
    input: LiveRtcControlClient.WaitForMessageInput
): boolean {
    const runtimeEvent = runtimeEventPayload(event);
    const data = messageData(event);
    return event.agentId === input.agentId &&
        runtimeEvent.kind === 'message' &&
        runtimeEvent.transport === input.transport &&
        data.matrixId === input.matrixId &&
        data.deliveryMode === input.deliveryMode;
}

function safeFileName(value: string): string {
    return value.replace(/[^a-zA-Z0-9_.-]+/g, '-');
}
