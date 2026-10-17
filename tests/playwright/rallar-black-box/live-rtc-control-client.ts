import {
    expect,
    type APIRequestContext,
    type BrowserContext,
    type Page,
    type TestInfo
} from '@playwright/test';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import {
    readRtcNativeAcquisition,
    type RtcNativeAcquisitionFailure,
    type RtcNativeAcquisitionProof,
    type RtcNativeCapturedConnection
} from '@shared-test/black-box-runner/artifacts/rtc-native-acquisition.ts';
import { Either } from '@shared/resilience/Either.ts';
import { toError } from '@shared/resilience/to-error.ts';
import type { RtcBaselineJson } from '../../../packages/shared-rtc-bench/baseline/contracts/rtc-baseline-contracts.ts';
import type { BlackBoxRallarRuntime } from '../../../packages/shared-test/black-box-runner/browser/rallar-browser-runtime/black-box-rallar-runtime-contract.ts';
import type { RallarBlackBoxTestCommand } from '../../../packages/shared-test/rallar-bb-test/rallar-black-box-test-contracts.ts';

import { expectLiveRtcArtifactEvidence } from './expect-live-rtc-artifact-evidence.ts';
import {
    buildLiveRtcAgentDiagnostics,
    toLiveRtcLifecycleHistory,
    type LiveRtcAgentDiagnostics,
    type LiveRtcLifecycleFailureInterval
} from './live-rtc-agent-diagnostics.ts';
import { LiveRtcBrowserRecording } from './live-rtc-browser-recording.ts';
import {
    classifyNackEvent,
    classifyNackResult,
    messageData,
    messageIdFromSendResult,
    summarizeLiveRtcFailureAgentHealth,
    summarizeMessageFailureAgentHealth,
    summarizeNackSendResult,
    toFailedControlResult,
    toMessageFailureDiagnostic,
    unavailableLiveRtcFailureAgentHealth,
    unavailableMessageFailureAgentHealth
} from './live-rtc-control-diagnostic-projections.ts';

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
import type {
    LiveRtcAttemptFailureDiagnostic,
    LiveRtcDiagnosticsCheckpoint,
    LiveRtcFailureAgentHealth,
    LiveRtcMessageFailureAgentHealth,
    LiveRtcMessageFailureDiagnostic,
    LiveRtcNackFailureDiagnostic,
    LiveRtcNackProbeStage
} from './live-rtc-performance-evidence.ts';
import { readLiveRtcRecorderJsonl, readLiveRtcRecorderRows } from './live-rtc-recorder-reader.ts';
import { summarizeLiveRtcNackWireObservation } from './live-rtc-wire-observation.ts';

export interface LiveRtcObservedDeliveries {
    readonly events: readonly LiveRtcControlClient.Event[];
    readonly scenarios: readonly LiveRtcControlClient.DeliveryScenario[];
}

interface FirstMessageFailureCase {
    readonly senderAgentId: string;
    readonly transport: 'realtime' | 'messages.rtc';
    readonly matrixId: string;
    readonly deliveryMode: string;
    readonly possibleReceiverAgentIds: readonly string[];
}

const MAX_RETAINED_MESSAGE_FAILURES = 2;

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

    export interface CaptureNackFailureInput {
        readonly runId: string;
        readonly senderAgentId: string;
        readonly targetAgentId: string;
        readonly commandId: string;
        readonly stage: LiveRtcNackProbeStage;
        readonly messageId: string | null;
        readonly senderSessionId: string;
        readonly targetSessionId: string;
        readonly frames: readonly string[];
    }

    export interface RunCapture {
        readonly succeeded: boolean;
        readonly run: RunSnapshot | undefined;
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
        senderAgentId: string;
        agentId: string;
        transport: 'realtime' | 'messages.rtc';
        matrixId: string;
        deliveryMode: string;
        possibleReceiverAgentIds?: readonly string[];
        startedAtMs: number;
        timeoutMs?: number;
    }

    export interface WaitForRtcReadinessInput {
        runId: string;
        agent: Pick<FormationAgent, 'agentId' | 'prefix' | 'refreshRoom'>;
        expectedPeerIds: readonly string[];
        suffix: string;
        startedAtMs: number;
    }

    export interface CaptureAttemptFailureInput {
        readonly runId: string;
    }

    export interface WaitForPeerAbsenceInput {
        runId: string;
        agent: Pick<FormationAgent, 'agentId' | 'prefix'>;
        departedPeerIds: readonly string[];
        suffix: string;
    }

    export interface CaptureDiagnosticsInput {
        testInfo: Pick<TestInfo, 'attach'>;
        runId: string;
        agents: readonly (Pick<FormationAgent, 'agentId' | 'prefix'> & { readonly page?: object; })[];
        label: string;
        cycle: number | null;
        readonly failureInterval?: LiveRtcLifecycleFailureInterval;
    }

    export interface CapturedDiagnostics {
        commandIds: readonly string[];
        checkpoint: LiveRtcDiagnosticsCheckpoint;
    }

    export interface ReadAgentDiagnosticsInput {
        readonly runId: string;
        readonly agentId: string;
        readonly commandId: string;
        readonly timeoutMs: number;
    }
}

export class LiveRtcControlClient {
    readonly browserRecording: LiveRtcBrowserRecording;
    readonly #request: APIRequestContext;
    readonly #baseUrl: string;
    readonly #diagnosticsOutDir: string | undefined;
    readonly #monotonicNow: () => number;
    readonly #epochNow: () => number;
    readonly #messageFailures: LiveRtcMessageFailureDiagnostic[] = [];
    readonly #messageFailureCaptures = new Set<Promise<void>>();
    readonly #messageFailureReceiverAgentIds = new Set<string>();
    #firstMessageFailureCase: FirstMessageFailureCase | undefined;

    constructor(input: LiveRtcControlClient.Dependencies) {
        this.#request = input.request;
        this.#baseUrl = input.baseUrl;
        this.#diagnosticsOutDir = input.diagnosticsOutDir;
        this.#monotonicNow = input.monotonicNow;
        this.#epochNow = input.epochNow;
        this.browserRecording = new LiveRtcBrowserRecording(this);
    }

    async fetchRun(runId: string): Promise<LiveRtcControlClient.RunSnapshot> {
        const response = await this.#request.get(
            `${this.#baseUrl}/runs/${encodeURIComponent(runId)}`
        );
        try {
            expect(response.ok()).toBe(true);
            return decodeControlRunSnapshot(normalizeJson(await response.json()));
        }
        finally {
            await response.dispose();
        }
    }

    async executeResult(
        input: LiveRtcControlClient.ExecuteInput
    ): Promise<LiveRtcControlClient.Result> {
        await this.#enqueueCommand(input);

        let latest: LiveRtcControlClient.Result | undefined;
        await expect
            .poll(
                async () => {
                    const response = await this.#request.get(
                        `${this.#baseUrl}/runs/${encodeURIComponent(input.runId)}` +
                            '?limitEvents=0&limitStats=0&limitReports=0&limitHeartbeats=0'
                    );
                    try {
                        expect(response.ok()).toBe(true);
                        const run = decodeControlRunSnapshot(normalizeJson(await response.json()));
                        latest = run.results.find(
                            (result) => result.commandId === input.commandId
                        );
                        return Boolean(latest);
                    }
                    finally {
                        await response.dispose();
                    }
                },
                {
                    timeout: input.timeoutMs ?? 45_000
                }
            )
            .toBe(true);
        if (!latest) {
            throw new Error(`Command ${input.commandId} did not return a result.`);
        }
        return latest;
    }

    async #enqueueCommand(input: LiveRtcControlClient.ExecuteInput): Promise<void> {
        const response = await this.#request.post(
            `${this.#baseUrl}/runs/${encodeURIComponent(input.runId)}/agents/${
                encodeURIComponent(
                    input.agentId
                )
            }/commands`,
            {
                data: {
                    commandId: input.commandId,
                    command: input.command
                }
            }
        );
        try {
            expect(
                response.status(),
                `Expected command ${input.commandId} for agent ${input.agentId} to enqueue: ${await response.text()}`
            ).toBe(202);
        }
        finally {
            await response.dispose();
        }
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

    resultValue(result: LiveRtcControlClient.Result): LiveRtcJsonRecord {
        return jsonRecord(result.result?.value) ?? {};
    }

    requireSessionId(
        result: LiveRtcControlClient.Result,
        commandId: string
    ): string {
        const sessionId = stringValue(this.resultValue(result).sessionId);
        if (!sessionId) {
            throw new Error(
                `Connect result ${commandId} did not include a sessionId.`
            );
        }
        return sessionId;
    }

    requireSentMessageId(result: LiveRtcControlClient.Result): string {
        const messageId = messageIdFromSendResult(result);
        if (!messageId) {
            throw new Error('RTC send result did not include a message ID.');
        }
        return messageId;
    }

    readyPeerIds(result: LiveRtcControlClient.Result): readonly string[] {
        return stringArrayValue(
            jsonRecord(jsonRecord(this.resultValue(result).rallar)?.rtcStatus)
                ?.readyPeerIds
        );
    }

    runtimeTopics(run: LiveRtcControlClient.RunSnapshot): readonly string[] {
        return run.events
            .map((event) => stringValue(jsonRecord(event.payload)?.topic))
            .filter((topic): topic is string => Boolean(topic));
    }

    async waitForMessage(
        input: LiveRtcControlClient.WaitForMessageInput
    ): Promise<number> {
        try {
            await expect
                .poll(
                    async () => {
                        const run = await this.fetchRun(input.runId);
                        return run.events.some((event) => isMessageFor(event, input));
                    },
                    {
                        message:
                            `Expected ${input.agentId} to receive ${input.transport} ${input.deliveryMode} ${input.matrixId}`,
                        timeout: input.timeoutMs ?? 60_000
                    }
                )
                .toBe(true);
        }
        catch (cause) {
            const capture = this.#recordMessageFailure(input);
            this.#messageFailureCaptures.add(capture);
            try {
                await capture;
            }
            catch (diagnosticCause) {
                console.error(
                    'Failed to record RTC message diagnostics',
                    toError(diagnosticCause)
                );
            }
            finally {
                this.#messageFailureCaptures.delete(capture);
            }
            throw cause;
        }
        return this.#monotonicNow() - input.startedAtMs;
    }

    async #recordMessageFailure(
        input: LiveRtcControlClient.WaitForMessageInput
    ): Promise<void> {
        if (!this.#acceptsMessageFailure(input)) {
            return;
        }
        const diagnostic = await this.#captureMessageFailure(input);
        this.#messageFailures.push(diagnostic);
        await this.#writeDiagnosticsArtifact(
            `live-rtc-message-failure-${safeFileName(input.matrixId)}-${safeFileName(input.agentId)}.json`,
            JSON.stringify(diagnostic, null, 2)
        );
    }

    #acceptsMessageFailure(
        input: LiveRtcControlClient.WaitForMessageInput
    ): boolean {
        const possibleReceiverAgentIds = [
            ...new Set(input.possibleReceiverAgentIds ?? [input.agentId])
        ].slice(0, MAX_RETAINED_MESSAGE_FAILURES);
        const firstMessageFailureCase = this.#firstMessageFailureCase;
        if (!firstMessageFailureCase) {
            this.#firstMessageFailureCase = {
                senderAgentId: input.senderAgentId,
                transport: input.transport,
                matrixId: input.matrixId,
                deliveryMode: input.deliveryMode,
                possibleReceiverAgentIds
            };
        }
        const retainedMessageFailureCase = this.#firstMessageFailureCase;
        if (
            !retainedMessageFailureCase ||
            retainedMessageFailureCase.senderAgentId !== input.senderAgentId ||
            retainedMessageFailureCase.transport !== input.transport ||
            retainedMessageFailureCase.matrixId !== input.matrixId ||
            retainedMessageFailureCase.deliveryMode !== input.deliveryMode ||
            !retainedMessageFailureCase.possibleReceiverAgentIds.includes(input.agentId) ||
            this.#messageFailureReceiverAgentIds.has(input.agentId)
        ) {
            return false;
        }
        this.#messageFailureReceiverAgentIds.add(input.agentId);
        return true;
    }

    async #captureMessageFailure(
        input: LiveRtcControlClient.WaitForMessageInput
    ): Promise<LiveRtcMessageFailureDiagnostic> {
        const healthByAgentId = await this.#captureMessageFailureHealth(input);
        const runCapture = await this.#captureRun(input.runId);
        return toMessageFailureDiagnostic({
            waitForMessage: input,
            healthByAgentId,
            runCapture,
            capturedAtEpochMs: this.#epochNow()
        });
    }

    async #captureMessageFailureHealth(
        input: LiveRtcControlClient.WaitForMessageInput
    ): Promise<Readonly<Record<string, LiveRtcMessageFailureAgentHealth>>> {
        const agentIds = [...new Set([input.senderAgentId, input.agentId])];
        const healthEntries = await Promise.all(
            agentIds.map((agentId) => this.#captureMessageFailureAgentHealth(input, agentId))
        );
        return Object.fromEntries(healthEntries);
    }

    async #captureMessageFailureAgentHealth(
        input: LiveRtcControlClient.WaitForMessageInput,
        agentId: string
    ): Promise<readonly [string, LiveRtcMessageFailureAgentHealth]> {
        try {
            const health = await this.executeResult({
                runId: input.runId,
                agentId,
                commandId: `health-message-failure-${safeFileName(input.matrixId)}-${safeFileName(input.agentId)}-${
                    safeFileName(agentId)
                }`,
                command: { kind: 'health', includeRtcDiagnostics: true },
                timeoutMs: 15_000
            });
            return [
                agentId,
                health.ok
                    ? summarizeMessageFailureAgentHealth(
                        buildLiveRtcAgentDiagnostics(agentId, this.resultValue(health))
                    )
                    : unavailableMessageFailureAgentHealth(true, false)
            ];
        }
        catch {
            return [agentId, unavailableMessageFailureAgentHealth(false, null)];
        }
    }

    async waitForPeerReadiness(
        input: LiveRtcControlClient.WaitForRtcReadinessInput
    ): Promise<number> {
        const deadlineMs = this.#monotonicNow() + 60_000;
        const readyAtMs = await this.#observeRtcReadiness(input, deadlineMs);
        if (readyAtMs >= deadlineMs) {
            throw new Error(
                `RTC room refresh for ${input.agent.agentId} exceeded the readiness deadline.`
            );
        }
        return readyAtMs - input.startedAtMs;
    }

    async #observeRtcReadiness(
        input: LiveRtcControlClient.WaitForRtcReadinessInput,
        deadlineMs: number
    ): Promise<number> {
        let attempt = 0;
        try {
            await expect
                .poll(
                    async () =>
                        await this.#readRtcReadiness(
                            input,
                            deadlineMs,
                            attempt++
                        ),
                    {
                        message: `Expected ${input.agent.agentId} to see ready peers ${
                            input.expectedPeerIds.join(
                                ', '
                            )
                        } for ${input.suffix}`,
                        timeout: 60_000
                    }
                )
                .toBe(true);
        }
        catch (cause) {
            try {
                await this.#recordReadinessFailure(input, attempt);
            }
            catch {
                console.error('Live RTC readiness diagnostic capture unavailable.');
            }
            throw cause;
        }
        return this.#monotonicNow();
    }

    async #readRtcReadiness(
        input: LiveRtcControlClient.WaitForRtcReadinessInput,
        deadlineMs: number,
        attempt: number
    ): Promise<boolean> {
        const refreshTimeoutMs = deadlineMs - this.#monotonicNow();
        if (refreshTimeoutMs <= 0) {
            throw new Error(
                `RTC room refresh for ${input.agent.agentId} exceeded the readiness deadline.`
            );
        }
        await input.agent.refreshRoom({ refresh: 'always', timeoutMs: refreshTimeoutMs });
        const healthTimeoutMs = Math.min(
            15_000,
            deadlineMs - this.#monotonicNow()
        );
        if (healthTimeoutMs <= 0) {
            throw new Error(
                `RTC room refresh for ${input.agent.agentId} exceeded the readiness deadline.`
            );
        }
        const result = await this.executeResult({
            runId: input.runId,
            agentId: input.agent.agentId,
            commandId: `health-ready-${input.agent.prefix.toLowerCase()}-${input.suffix}-${attempt}`,
            command: { kind: 'health' },
            timeoutMs: healthTimeoutMs
        }).catch(() => undefined);
        if (!result?.ok) {
            return false;
        }
        const rallar = jsonRecord(this.resultValue(result).rallar);
        const readyPeerIds = stringArrayValue(
            jsonRecord(rallar?.rtcStatus)?.readyPeerIds
        );
        return input.expectedPeerIds.every((peerId) => readyPeerIds.includes(peerId));
    }

    async #recordReadinessFailure(
        input: LiveRtcControlClient.WaitForRtcReadinessInput,
        attempt: number
    ): Promise<void> {
        if (!this.#diagnosticsOutDir) {
            return;
        }
        const health = await this.#readAgentDiagnostics({
            runId: input.runId,
            agentId: input.agent.agentId,
            commandId: `health-readiness-failure-${input.agent.prefix.toLowerCase()}-${input.suffix}-${attempt}`,
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
                    failure: { name: 'rtc-readiness-failed', message: 'RTC peer readiness observation failed.' },
                    health
                },
                null,
                2
            )
        );
    }

    async captureAttemptFailure(
        input: LiveRtcControlClient.CaptureAttemptFailureInput
    ): Promise<LiveRtcAttemptFailureDiagnostic> {
        await Promise.allSettled(this.#messageFailureCaptures);
        try {
            const run = await this.fetchRun(input.runId);
            return {
                kind: 'control-result-failures',
                runCaptureSucceeded: true,
                failedResults: run.results
                    .filter(
                        (result): result is LiveRtcControlClient.Result & { ok: false; } => result.ok === false
                    )
                    .slice(-20)
                    .map(toFailedControlResult),
                messageFailures: this.#messageFailures
            };
        }
        catch {
            return {
                kind: 'control-result-failures',
                runCaptureSucceeded: false,
                failedResults: [],
                messageFailures: this.#messageFailures
            };
        }
    }

    async waitForPeerAbsence(
        input: LiveRtcControlClient.WaitForPeerAbsenceInput
    ): Promise<void> {
        let attempt = 0;
        await expect
            .poll(
                async () => {
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
                },
                {
                    message: `Expected ${input.agent.agentId} to observe departed peers ${
                        input.departedPeerIds.join(
                            ', '
                        )
                    } for ${input.suffix}`,
                    timeout: 60_000
                }
            )
            .toEqual([]);
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
        let bundle: LiveRtcJsonRecord;
        try {
            expect(response.ok()).toBe(true);
            bundle = requiredJsonRecord(
                normalizeJson(await response.json()),
                '$.artifactBundle'
            );
        }
        finally {
            await response.dispose();
        }
        await expectLiveRtcArtifactEvidence(bundle, input, this.#baseUrl);
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

    async readRtcNativeAcquisition(
        connection: RtcNativeCapturedConnection
    ): Promise<Either<RtcNativeAcquisitionFailure, RtcNativeAcquisitionProof>> {
        const endpoint = `${this.#baseUrl}/runs/${encodeURIComponent(connection.runId)}/events.jsonl`;
        return readRtcNativeAcquisition(connection, endpoint, readLiveRtcRecorderRows(endpoint));
    }

    async captureDiagnostics(
        input: LiveRtcControlClient.CaptureDiagnosticsInput
    ): Promise<LiveRtcControlClient.CapturedDiagnostics> {
        if (input.agents.length !== 3 || new Set(input.agents.map((agent) => agent.agentId)).size !== 3) {
            throw new Error('RTC diagnostics require three distinct agents.');
        }
        const health = await this.#readDiagnostics(input);
        const captured = input.failureInterval
            ? await this.#readFailureLifecycleHistory(input, health)
            : health;
        const body = JSON.stringify(
            {
                runId: input.runId,
                capturedAtEpochMs: this.#epochNow(),
                ...captured.checkpoint
            },
            null,
            2
        );
        try {
            await input.testInfo.attach(`live-rtc-diagnostics-${input.label}.json`, {
                body,
                contentType: 'application/json'
            });
        }
        catch {
            console.error('Live RTC diagnostic attachment unavailable.');
        }
        try {
            await this.#writeDiagnosticsArtifact(`live-rtc-diagnostics-${safeFileName(input.label)}.json`, body);
        }
        catch {
            console.error('Live RTC diagnostic sidecar unavailable.');
        }
        return captured;
    }

    async #readDiagnostics(
        input: LiveRtcControlClient.CaptureDiagnosticsInput
    ): Promise<LiveRtcControlClient.CapturedDiagnostics> {
        const commandIds: string[] = [];
        const agents: LiveRtcAgentDiagnostics[] = [];
        for (const agent of input.agents) {
            this.browserRecording.assertAgent(agent);
            const commandId = `rtc-diagnostics-${agent.prefix.toLowerCase()}-${input.label}`;
            commandIds.push(commandId);
            agents.push(
                await this.#readAgentDiagnostics({
                    runId: input.runId,
                    agentId: agent.agentId,
                    commandId,
                    timeoutMs: 30_000
                })
            );
        }
        const checkpoint: LiveRtcDiagnosticsCheckpoint = {
            label: input.label,
            cycle: input.cycle,
            agents
        };
        return { commandIds, checkpoint };
    }

    async #readFailureLifecycleHistory(
        input: LiveRtcControlClient.CaptureDiagnosticsInput,
        health: LiveRtcControlClient.CapturedDiagnostics
    ): Promise<LiveRtcControlClient.CapturedDiagnostics> {
        if (!input.failureInterval) {
            return health;
        }
        const read = await readLiveRtcRecorderJsonl(
            `${this.#baseUrl}/runs/${encodeURIComponent(input.runId)}/events.jsonl`
        );
        const recorder = read.right;
        const historyByAgentId = toLiveRtcLifecycleHistory({
            jsonl: recorder?.jsonl ?? null,
            bytesRead: recorder?.bytesRead ?? 0,
            retainedBytes: recorder?.retainedBytes ?? 0,
            retainedPrefixDropped: recorder?.retainedPrefixDropped ?? false,
            transportTruncated: recorder?.transportTruncated ?? false,
            failureInterval: input.failureInterval,
            cycle: input.cycle,
            agentIds: input.agents.map((agent) => agent.agentId)
        });
        return {
            ...health,
            checkpoint: {
                ...health.checkpoint,
                agents: health.checkpoint.agents.map((agent) => ({
                    ...agent,
                    details: normalizeJson({
                        ...requiredJsonRecord(agent.details, 'RTC diagnostic details'),
                        lifecycleHistory: historyByAgentId[agent.agentId]
                    })
                }))
            }
        };
    }

    async #readAgentDiagnostics(
        input: LiveRtcControlClient.ReadAgentDiagnosticsInput
    ): Promise<LiveRtcAgentDiagnostics> {
        const result = await this.executeOk({
            ...input,
            command: { kind: 'health', includeRtcDiagnostics: true }
        });
        const diagnostics = buildLiveRtcAgentDiagnostics(input.agentId, this.resultValue(result));
        return {
            ...diagnostics,
            details: normalizeJson({
                ...requiredJsonRecord(diagnostics.details, 'RTC diagnostic details'),
                ...this.browserRecording.observe(input.runId, result),
                healthCapturedAtEpochMs: this.#epochNow()
            })
        };
    }

    async #writeDiagnosticsArtifact(
        fileName: string,
        body: string
    ): Promise<void> {
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
        const body = JSON.stringify(
            { observation: 'received-protocol-nack', ...evidence },
            null,
            2
        );
        const fileName = `live-rtc-received-nack-${safeFileName(input.agentId)}.json`;
        await testInfo.attach(fileName, { body, contentType: 'application/json' });
        await this.#writeDiagnosticsArtifact(fileName, body);
    }

    async captureNackFailure(
        input: LiveRtcControlClient.CaptureNackFailureInput
    ): Promise<LiveRtcNackFailureDiagnostic> {
        const healthByAgentId = await this.#captureNackHealth(input);
        const runCapture = await this.#captureRun(input.runId);
        const run = runCapture.run;
        return {
            kind: 'nack-probe-failure',
            runId: input.runId,
            senderAgentId: input.senderAgentId,
            targetAgentId: input.targetAgentId,
            commandId: input.commandId,
            stage: input.stage,
            messageId: input.messageId,
            senderSessionId: input.senderSessionId,
            targetSessionId: input.targetSessionId,
            capturedAtEpochMs: this.#epochNow(),
            failureMessage: nackFailureMessage(input.stage),
            healthByAgentId,
            runCaptureSucceeded: runCapture.succeeded,
            sendResult: summarizeNackSendResult(
                (run?.results ?? []).find(
                    (result) =>
                        result.agentId === input.senderAgentId &&
                        result.commandId === input.commandId
                ),
                input.messageId
            ) ?? null,
            wireObservation: summarizeLiveRtcNackWireObservation({
                frames: input.frames,
                messageId: input.messageId,
                senderSessionId: input.senderSessionId,
                targetSessionId: input.targetSessionId
            }),
            recentResults: (run?.results ?? [])
                .slice(-100)
                .map((result) => classifyNackResult(result, input)),
            recentEvents: (run?.events ?? [])
                .slice(-100)
                .map((event) => classifyNackEvent(event, input))
        };
    }

    async #captureNackHealth(
        input: LiveRtcControlClient.CaptureNackFailureInput
    ): Promise<Readonly<Record<string, LiveRtcFailureAgentHealth>>> {
        const agentIds = [...new Set([input.senderAgentId, input.targetAgentId])];
        const entries = await Promise.all(
            agentIds.map((agentId) => this.#captureNackAgentHealth(input, agentId))
        );
        return Object.fromEntries(entries);
    }

    async #captureNackAgentHealth(
        input: LiveRtcControlClient.CaptureNackFailureInput,
        agentId: string
    ): Promise<readonly [string, LiveRtcFailureAgentHealth]> {
        try {
            const health = await this.executeResult({
                runId: input.runId,
                agentId,
                commandId: `health-nack-failure-${safeFileName(input.commandId)}-${safeFileName(agentId)}`,
                command: { kind: 'health', includeRtcDiagnostics: true },
                timeoutMs: 15_000
            });
            return [
                agentId,
                health.ok
                    ? summarizeLiveRtcFailureAgentHealth(
                        buildLiveRtcAgentDiagnostics(agentId, this.resultValue(health))
                    )
                    : unavailableLiveRtcFailureAgentHealth(true, false)
            ];
        }
        catch {
            return [agentId, unavailableLiveRtcFailureAgentHealth(false, null)];
        }
    }

    async #captureRun(
        runId: string
    ): Promise<LiveRtcControlClient.RunCapture> {
        try {
            return { succeeded: true, run: await this.fetchRun(runId) };
        }
        catch {
            return { succeeded: false, run: undefined };
        }
    }
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
        return (
            scenario !== undefined &&
            event.agentId !== undefined &&
            !scenario.allowedAgentIds.includes(event.agentId)
        );
    }).length;
}

function nackFailureMessage(stage: LiveRtcNackProbeStage): string {
    switch (stage) {
        case 'start-observation':
            return 'RTC NACK probe could not start wire observation.';
        case 'send':
            return 'RTC NACK probe send did not complete.';
        case 'message-identity':
            return 'RTC NACK probe send result did not provide its message identity.';
        case 'receive':
            return 'RTC NACK probe did not observe the expected response.';
        case 'record-receipt':
            return 'RTC NACK probe could not retain its successful receipt evidence.';
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
            const result = requiredJsonRecord(
                entry,
                `$.controlRun.results[${index}]`
            );
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
                ok: requiredBoolean(result.ok, `$.controlRun.results[${index}].ok`),
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

function isMessageFor(
    event: LiveRtcControlClient.Event,
    input: LiveRtcControlClient.WaitForMessageInput
): boolean {
    const runtimeEvent = jsonRecord(event.payload) ?? {};
    const data = messageData(event);
    return (
        event.agentId === input.agentId &&
        runtimeEvent.kind === 'message' &&
        runtimeEvent.transport === input.transport &&
        data.matrixId === input.matrixId &&
        data.deliveryMode === input.deliveryMode
    );
}

function safeFileName(value: string): string {
    return value.replace(/[^a-zA-Z0-9_.-]+/g, '-');
}
