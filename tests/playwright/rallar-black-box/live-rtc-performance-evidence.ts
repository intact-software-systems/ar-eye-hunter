import {
    expect,
    type APIRequestContext,
    type BrowserContext,
    type Page,
    type TestInfo
} from '@playwright/test';
import { lstat, mkdir, open, readFile, realpath, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { deriveRtcBaselineExternalAttempts } from '../../../packages/shared-rtc-bench/baseline/catalog/rtc-baseline-workload-manifest.ts';
import {
    decodeRtcBaselineEnvironment,
    decodeRtcBaselineExternalAttempt,
    decodeRtcBaselineManifest
} from '../../../packages/shared-rtc-bench/baseline/contracts/rtc-baseline-artifact-decoding.ts';
import {
    validateRtcBaselineExternalAttempt,
    validateRtcBaselineExternalCohort
} from '../../../packages/shared-rtc-bench/baseline/contracts/rtc-baseline-artifact-validation.ts';
import type {
    RtcBaselineAttemptLocatorDto,
    RtcBaselineCohortIdentityDto,
    RtcBaselineEnvironmentDto,
    RtcBaselineExternalAttemptDto,
    RtcBaselineExternalCohortDto,
    RtcBaselineIssueDto,
    RtcBaselineJson,
    RtcBaselineRuntimeObservationDto,
    RtcBaselineSampleDto,
    RtcBaselineSampleIdentityDto
} from '../../../packages/shared-rtc-bench/baseline/contracts/rtc-baseline-contracts.ts';

export interface LiveRtcPerformanceIdentity {
    workloadId: 'RTC-B06';
    caseId: 'default' | 'all-scenarios' | 'retention-100';
    inputKey:
        | 'e3-memory-default'
        | 'e3-memory-all-scenarios'
        | 'e3-memory-retention-100'
        | 'e4-pg-default'
        | 'e4-pg-all-scenarios'
        | 'e4-pg-retention-100';
    intendedPhase: 'warmup' | 'retained';
    outerOrdinal: number;
    environmentId: 'E3-memory' | 'E4-pg';
}

export interface LiveRtcPerformanceProducer {
    provider: 'browser-rallar';
    browserCount: 3;
    auth: Readonly<{
        A: 'login' | 'restore';
        B: 'login' | 'restore';
        C: 'login' | 'restore';
    }>;
    databaseProvider: 'memory' | 'postgres';
    databaseUrl: 'present' | 'absent';
    iceMode: 'repository-default' | 'local';
    allScenariosRaw: string | null;
    retentionSoakRaw: string | null;
    retentionCyclesRaw: string | null;
    iceModeRaw: string | null;
    transports: readonly ['realtime', 'messages.rtc'];
}

export interface LiveRtcPerformanceRuntime {
    node: string;
    playwright: string;
    chromium: string;
}

export interface LiveRtcPerformanceTiming {
    kind:
        | 'peer-ready'
        | 'direct-delivery'
        | 'multicast-delivery'
        | 'broadcast-delivery'
        | 'reconnect-ready';
    transport: 'realtime' | 'messages.rtc';
    senderAgentId: string;
    receiverAgentIds: readonly string[];
    durationMs: number;
}

export interface LiveRtcAgentDiagnostics {
    agentId: string;
    settledPeerIds: readonly string[];
    readyPeerIds: readonly string[];
    laneStates: readonly LiveRtcLaneDiagnostics[];
    connectionTimerActive: boolean;
    peerCount: number;
    connectedPeerCount: number;
    relayPeerCount: number;
    details: RtcBaselineJson;
}

export interface LiveRtcLaneDiagnostics {
    peerId: string;
    laneId: string;
    isOpen: boolean;
    isReconnectable: boolean;
}

export interface LiveRtcDiagnosticsCheckpoint {
    label: string;
    cycle: number | null;
    agents: readonly LiveRtcAgentDiagnostics[];
}

export interface LiveRtcRetentionCheckpoint {
    cycle: number;
    postGcHeapBytes: number;
    agents: readonly LiveRtcAgentDiagnostics[];
}

export interface LiveRtcRetentionEvidence {
    cycles: 100;
    checkpoints: readonly LiveRtcRetentionCheckpoint[];
    settledStateReturned: boolean;
}

export interface LiveRtcPerformanceAssertions {
    matrixPassed: boolean;
    artifactBundlePassed: boolean;
    unexpectedDeliveryCount: number;
    reconnectPassed: boolean | null;
}

export interface LiveRtcPerformanceRawEvidence {
    identity: LiveRtcPerformanceIdentity;
    producer: LiveRtcPerformanceProducer;
    runtime: LiveRtcPerformanceRuntime;
    timings: readonly LiveRtcPerformanceTiming[];
    diagnostics: readonly LiveRtcDiagnosticsCheckpoint[];
    retention: LiveRtcRetentionEvidence | null;
    assertions: LiveRtcPerformanceAssertions;
}

export interface BuildLiveRtcExternalAttemptInput {
    locator: RtcBaselineAttemptLocatorDto;
    sampleIdentity: RtcBaselineSampleIdentityDto;
    producerExitStatus: number;
    runtimeObservation: RtcBaselineRuntimeObservationDto;
    rawEvidence: LiveRtcPerformanceRawEvidence;
}

export interface BuildLiveRtcRetentionCohortInput {
    identity: RtcBaselineCohortIdentityDto;
    attempts: readonly RtcBaselineExternalAttemptDto[];
}

export interface WriteLiveRtcPerformanceEvidenceInput {
    repoRoot: string;
    baselineId: string;
    relativePath: string;
    evidence: RtcBaselineExternalAttemptDto | RtcBaselineExternalCohortDto;
}

export interface LoadLiveRtcPerformanceAttemptInput {
    repoRoot: string;
    environment: Readonly<Record<string, string | undefined>>;
}

export interface LiveRtcPerformanceAttemptContext {
    repoRoot: string;
    baselineId: string;
    locator: LiveRtcPerformanceAttemptLocator;
    sampleIdentity: RtcBaselineSampleIdentityDto;
    runtimeObservation: RtcBaselineRuntimeObservationDto;
}

export interface LiveRtcPerformanceAttemptLocator extends RtcBaselineAttemptLocatorDto {
    workloadId: 'RTC-B06';
    caseId: LiveRtcPerformanceIdentity['caseId'];
    inputKey: LiveRtcPerformanceIdentity['inputKey'];
    environmentId: LiveRtcPerformanceIdentity['environmentId'];
}

export namespace LiveRtcControlClient {
    export interface Agent {
        context: BrowserContext;
        page: Page;
        prefix: 'A' | 'B' | 'C';
        agentId: string;
        actor: string;
        connection: string;
    }

    export interface Result {
        agentId?: string;
        commandId?: string;
        ok?: boolean;
        result?: Readonly<{ value?: RtcBaselineJson; }>;
        error?: RtcBaselineJson;
    }

    export interface Event {
        kind?: string;
        agentId?: string;
        payload?: RtcBaselineJson;
    }

    export interface RunSnapshot {
        agents?: readonly Readonly<{ agentId?: string; }>[];
        results?: readonly Result[];
        events?: readonly Event[];
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
        command: object;
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
        agent: Agent;
        expectedPeerIds: readonly string[];
        suffix: string;
        startedAtMs: number;
    }

    export interface WaitForPeerAbsenceInput {
        runId: string;
        agent: Agent;
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

    constructor(input: Readonly<{
        request: APIRequestContext;
        baseUrl: string;
        diagnosticsOutDir?: string;
    }>) {
        this.#request = input.request;
        this.#baseUrl = input.baseUrl;
        this.#diagnosticsOutDir = input.diagnosticsOutDir;
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
            `${this.#baseUrl}/runs/${encodeURIComponent(input.runId)}/agents/${encodeURIComponent(input.agentId)}/commands`,
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
            latest = run.results?.find(
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
    ): { [key: string]: RtcBaselineJson; } {
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

    readyPeerIds(result: LiveRtcControlClient.Result): readonly string[] {
        return stringArrayValue(
            jsonRecord(
                jsonRecord(this.resultValue(result).rallar)?.rtcStatus
            )?.readyPeerIds
        );
    }

    runtimeTopics(run: LiveRtcControlClient.RunSnapshot): readonly string[] {
        return (run.events ?? [])
            .map((event) => stringValue(runtimeEventPayload(event).topic))
            .filter((topic): topic is string => Boolean(topic));
    }

    async waitForMessage(
        input: LiveRtcControlClient.WaitForMessageInput
    ): Promise<number> {
        await expect.poll(async () => {
            const run = await this.fetchRun(input.runId);
            return run.events?.some((event) => isMessageFor(event, input)) ?? false;
        }, {
            message:
                `Expected ${input.agentId} to receive ${input.transport} ${input.deliveryMode} ${input.matrixId}`,
            timeout: 60_000
        }).toBe(true);
        return performance.now() - input.startedAtMs;
    }

    async waitForPeerReadiness(
        input: LiveRtcControlClient.WaitForPeerReadinessInput
    ): Promise<number> {
        let attempt = 0;
        await expect.poll(async () => {
            const result = await this.executeResult({
                runId: input.runId,
                agentId: input.agent.agentId,
                commandId:
                    `health-ready-${input.agent.prefix.toLowerCase()}-${input.suffix}-${attempt++}`,
                command: { kind: 'health' },
                timeoutMs: 15_000
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
            message:
                `Expected ${input.agent.agentId} to see ready peers ${input.expectedPeerIds.join(', ')} for ${input.suffix}`,
            timeout: 60_000
        }).toEqual(expect.arrayContaining([...input.expectedPeerIds]));
        return performance.now() - input.startedAtMs;
    }

    async waitForPeerAbsence(
        input: LiveRtcControlClient.WaitForPeerAbsenceInput
    ): Promise<void> {
        let attempt = 0;
        await expect.poll(async () => {
            const result = await this.executeResult({
                runId: input.runId,
                agentId: input.agent.agentId,
                commandId:
                    `health-absent-${input.agent.prefix.toLowerCase()}-${input.suffix}-${attempt++}`,
                command: { kind: 'health' },
                timeoutMs: 15_000
            }).catch(() => undefined);
            if (!result?.ok) {
                return input.departedPeerIds;
            }
            const readyPeerIds = this.readyPeerIds(result);
            return input.departedPeerIds.filter((peerId) => readyPeerIds.includes(peerId));
        }, {
            message:
                `Expected ${input.agent.agentId} to observe departed peers ${input.departedPeerIds.join(', ')} for ${input.suffix}`,
            timeout: 60_000
        }).toEqual([]);
    }

    async unexpectedDeliveryCount(input: Readonly<{
        runId: string;
        scenarios: readonly LiveRtcControlClient.DeliveryScenario[];
    }>): Promise<number> {
        const run = await this.fetchRun(input.runId);
        return countUnexpectedLiveRtcDeliveries({
            events: run.events ?? [],
            scenarios: input.scenarios
        });
    }

    async expectArtifactBundle(input: Readonly<{
        runId: string;
        commandIds: readonly string[];
    }>): Promise<void> {
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

    async attachRunSummary(input: Readonly<{
        testInfo: TestInfo;
        runId: string;
    }>): Promise<void> {
        const run = await this.fetchRun(input.runId);
        const body = JSON.stringify(
            {
                runId: input.runId,
                agents: run.agents?.map((agent) => agent.agentId),
                resultCount: run.results?.length ?? 0,
                eventCount: run.events?.length ?? 0
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
            const commandId =
                `rtc-diagnostics-${agent.prefix.toLowerCase()}-${input.label}`;
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
                capturedAtEpochMs: Date.now(),
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
}

const FIVE_MEBIBYTES = 5 * 1024 * 1024;
const LIVE_RTC_BASELINE_ID =
    /^(?:\d{8}-[0-9a-f]{12}-e(?:3-memory|4-pg)|\d{8}T\d{9}Z-[0-9a-f]{12}-e(?:3-memory|4-pg)-local)(?:-repeat-01)?$/u;
const attemptIdentityFields = [
    'workloadId',
    'caseId',
    'inputKey',
    'intendedPhase',
    'outerOrdinal'
] as const;

export async function loadLiveRtcPerformanceAttempt(
    input: LoadLiveRtcPerformanceAttemptInput
): Promise<LiveRtcPerformanceAttemptContext | null> {
    const names = [
        'RALLAR_BLACK_BOX_RTC_BASELINE_ID',
        'RALLAR_BLACK_BOX_RTC_CASE_ID',
        'RALLAR_BLACK_BOX_RTC_INPUT_KEY',
        'RALLAR_BLACK_BOX_RTC_INTENDED_PHASE',
        'RALLAR_BLACK_BOX_RTC_OUTER_ORDINAL'
    ] as const;
    const values = names.map((name) => {
        const value = input.environment[name];
        return value !== undefined && value.length > 0 ? value : undefined;
    });
    if (values.every((value) => value === undefined)) {
        return null;
    }
    const missing = names.filter((_, index) => values[index] === undefined);
    if (missing.length > 0) {
        throw new Error(`Live RTC evidence environment is missing ${missing.join(', ')}.`);
    }
    const [baselineId, caseId, inputKey, intendedPhase, ordinalRaw] = values as [
        string,
        string,
        string,
        string,
        string
    ];
    assertCanonicalLiveRtcBaselineId(baselineId);
    if (!/^[1-9][0-9]*$/u.test(ordinalRaw)) {
        throw new Error('RALLAR_BLACK_BOX_RTC_OUTER_ORDINAL must be a positive integer.');
    }
    const outerOrdinal = Number(ordinalRaw);
    if (!Number.isSafeInteger(outerOrdinal)) {
        throw new Error('RALLAR_BLACK_BOX_RTC_OUTER_ORDINAL must be a safe positive integer.');
    }
    const baselineRoot = resolve(
        input.repoRoot,
        'tmp',
        'perf',
        'rtc-baseline',
        baselineId
    );
    const manifest = await readBaselineManifest(baselineRoot);
    const environment = await readBaselineEnvironment(baselineRoot);
    const locator = deriveRtcBaselineExternalAttempts(manifest, 'RTC-B06').find(
        (attempt) =>
            attempt.caseId === caseId &&
            attempt.inputKey === inputKey &&
            attempt.intendedPhase === intendedPhase &&
            attempt.outerOrdinal === outerOrdinal
    );
    if (!locator || !isLiveRtcPerformanceAttemptLocator(locator)) {
        throw new Error('Live RTC evidence environment does not identify a predeclared attempt.');
    }
    const outerAttempt = manifest.outerAttempts.find(
        (attempt) =>
            attempt.workloadId === locator.workloadId &&
            attempt.caseId === locator.caseId &&
            attempt.inputKey === locator.inputKey &&
            attempt.intendedPhase === locator.intendedPhase &&
            attempt.outerOrdinal === locator.outerOrdinal
    );
    if (!outerAttempt || outerAttempt.sampleIds.length !== 1) {
        throw new Error('Live RTC evidence requires exactly one predeclared sample per attempt.');
    }
    if (!environment.observation) {
        throw new Error('Live RTC baseline initialization is missing its runtime observation.');
    }
    if (
        manifest.request.baselineId !== baselineId ||
        environment.baselineId !== baselineId ||
        environment.environmentId !== locator.environmentId ||
        !environment.workloadIds.includes('RTC-B06')
    ) {
        throw new Error('Live RTC manifest and environment do not match the selected attempt.');
    }
    return {
        repoRoot: input.repoRoot,
        baselineId,
        locator,
        sampleIdentity: {
            sampleId: outerAttempt.sampleIds[0]!,
            workloadId: outerAttempt.workloadId,
            caseId: outerAttempt.caseId,
            inputKey: outerAttempt.inputKey,
            intendedPhase: outerAttempt.intendedPhase,
            outerOrdinal: outerAttempt.outerOrdinal,
            innerOrdinal: 1
        },
        runtimeObservation: environment.observation
    };
}

function isLiveRtcPerformanceAttemptLocator(
    locator: RtcBaselineAttemptLocatorDto
): locator is LiveRtcPerformanceAttemptLocator {
    if (locator.workloadId !== 'RTC-B06') {
        return false;
    }
    if (locator.environmentId === 'E3-memory') {
        return locator.inputKey === `e3-memory-${locator.caseId}` &&
            ['default', 'all-scenarios', 'retention-100'].includes(locator.caseId);
    }
    if (locator.environmentId === 'E4-pg') {
        return locator.inputKey === `e4-pg-${locator.caseId}` &&
            ['default', 'all-scenarios', 'retention-100'].includes(locator.caseId);
    }
    return false;
}

export function buildLiveRtcExternalAttempt(
    input: BuildLiveRtcExternalAttemptInput
): RtcBaselineExternalAttemptDto {
    assertAttemptIdentity(input);
    assertProducerMatchesIdentity(input.rawEvidence);
    assertRuntimeMatchesObservation(input);
    const issues = attemptIssues(input);
    const sample: RtcBaselineSampleDto = {
        schema: 'rallar.rtc-baseline.sample.v1',
        identity: input.sampleIdentity,
        outcome: issues.length === 0 ? 'passed' : 'failed',
        evidenceClass: 'local-full-stack',
        metrics: performanceMetrics(input.rawEvidence),
        rawEvidence: normalizeJson(input.rawEvidence),
        rawReferences: [],
        issues,
        runtimeObservation: input.runtimeObservation
    };
    const attempt: RtcBaselineExternalAttemptDto = {
        schema: 'rallar.rtc-baseline.external-attempt.v1',
        locator: input.locator,
        producerExitStatus: input.producerExitStatus,
        producerFacts: producerFacts(input.rawEvidence),
        sampleOutcomes: [sampleOutcome(sample)],
        samples: [sample],
        issues: []
    };
    assertValidBuiltEvidence(validateRtcBaselineExternalAttempt(attempt));
    return attempt;
}

function assertRuntimeMatchesObservation(input: BuildLiveRtcExternalAttemptInput): void {
    const observed = input.runtimeObservation.runtime;
    const raw = input.rawEvidence.runtime;
    if (
        raw.node !== observed.node ||
        raw.playwright !== observed.playwright ||
        raw.chromium !== observed.chromium
    ) {
        throw new Error('Live RTC runtime facts do not match the baseline observation.');
    }
}

export function buildLiveRtcRetentionCohort(
    input: BuildLiveRtcRetentionCohortInput
): RtcBaselineExternalCohortDto {
    if (input.identity.workloadId !== 'RTC-B06') {
        throw new Error('Live RTC retention cohort workload must be RTC-B06.');
    }
    const samples = retainedSamplesInIdentityOrder(input);
    const requiredHeapBreachCount = heapBreachThreshold(samples.length);
    const heapBreachingSampleIds = samples
        .filter(retentionHeapBreached)
        .map((sample) => sample.identity.sampleId);
    const stateDriftSampleIds = samples
        .filter(retentionStateDrifted)
        .map((sample) => sample.identity.sampleId);
    const failedMemberSampleIds = samples
        .filter((sample) => sample.outcome !== 'passed' || sample.issues.length > 0)
        .map((sample) => sample.identity.sampleId);
    const issues: RtcBaselineIssueDto[] = [];
    if (heapBreachingSampleIds.length >= requiredHeapBreachCount) {
        issues.push({
            path: '$.rawEvidence.heapBreachingSampleIds',
            code: 'retention-heap-threshold-breached',
            message:
                `${heapBreachingSampleIds.length} retained attempts breached the ${requiredHeapBreachCount}-attempt heap threshold.`
        });
    }
    if (stateDriftSampleIds.length > 0) {
        issues.push({
            path: '$.rawEvidence.stateDriftSampleIds',
            code: 'retention-state-drift',
            message: 'Settled peer, lane, or connection-timer state did not return to cycle 0.'
        });
    }
    if (failedMemberSampleIds.length > 0) {
        issues.push({
            path: '$.rawEvidence.failedMemberSampleIds',
            code: 'retention-member-failed',
            message: 'Every retention cohort member must be a passing external sample.'
        });
    }
    const cohort: RtcBaselineExternalCohortDto = {
        schema: 'rallar.rtc-baseline.external-cohort.v1',
        identity: input.identity,
        outcome: issues.length === 0 ? 'passed' : 'failed',
        rawEvidence: {
            retainedAttemptCount: samples.length,
            requiredHeapBreachCount,
            heapBreachingSampleIds,
            stateDriftSampleIds,
            failedMemberSampleIds
        },
        issues,
        samples
    };
    assertValidBuiltEvidence(validateRtcBaselineExternalCohort(cohort));
    return cohort;
}

export async function writeLiveRtcRetentionCohortIfComplete(
    context: LiveRtcPerformanceAttemptContext
): Promise<string | null> {
    if (
        context.locator.caseId !== 'retention-100' ||
        context.locator.intendedPhase !== 'retained'
    ) {
        return null;
    }
    const baselineRoot = resolve(
        context.repoRoot,
        'tmp',
        'perf',
        'rtc-baseline',
        context.baselineId
    );
    const manifest = await readBaselineManifest(baselineRoot);
    const identity = manifest.expectedCohorts.find((cohort) =>
        cohort.workloadId === 'RTC-B06' &&
        cohort.memberSampleIds.includes(context.sampleIdentity.sampleId)
    );
    if (!identity) {
        throw new Error('Live RTC retention attempt is not owned by a predeclared cohort.');
    }
    if (identity.memberSampleIds.at(-1) !== context.sampleIdentity.sampleId) {
        return null;
    }
    const memberSampleIds = new Set(identity.memberSampleIds);
    const locators = deriveRtcBaselineExternalAttempts(manifest, 'RTC-B06').filter(
        (locator) => manifest.outerAttempts.some((attempt) =>
            attempt.workloadId === locator.workloadId &&
            attempt.caseId === locator.caseId &&
            attempt.inputKey === locator.inputKey &&
            attempt.intendedPhase === locator.intendedPhase &&
            attempt.outerOrdinal === locator.outerOrdinal &&
            attempt.sampleIds.length === 1 &&
            memberSampleIds.has(attempt.sampleIds[0]!)
        )
    );
    if (locators.length !== identity.memberSampleIds.length) {
        throw new Error('Live RTC retention cohort manifest membership is incomplete.');
    }
    const attempts = await Promise.all(
        locators.map((locator) => readExternalAttempt(
            resolve(baselineRoot, locator.rawResultRelativePath)
        ))
    );
    const cohort = buildLiveRtcRetentionCohort({ identity, attempts });
    return writeLiveRtcPerformanceEvidence({
        repoRoot: context.repoRoot,
        baselineId: context.baselineId,
        relativePath: `artifacts/staging/${identity.cohortId}.json`,
        evidence: cohort
    });
}

export async function writeLiveRtcPerformanceEvidence(
    input: WriteLiveRtcPerformanceEvidenceInput
): Promise<string> {
    assertCanonicalLiveRtcBaselineId(input.baselineId);
    if (
        isAbsolute(input.relativePath) ||
        !input.relativePath.startsWith('artifacts/staging/')
    ) {
        throw new Error('Live RTC staged evidence must be confined beneath artifacts/staging.');
    }
    normalizeJson(input.evidence);
    const realRepoRoot = await realpath(input.repoRoot);
    const baselineRoot = resolve(
        realRepoRoot,
        'tmp',
        'perf',
        'rtc-baseline',
        input.baselineId
    );
    const stagingRoot = resolve(baselineRoot, 'artifacts', 'staging');
    const outputPath = resolve(baselineRoot, input.relativePath);
    const confinedRelativePath = relative(stagingRoot, outputPath);
    if (
        confinedRelativePath === '' ||
        confinedRelativePath === '..' ||
        confinedRelativePath.startsWith(`..${sep}`) ||
        isAbsolute(confinedRelativePath)
    ) {
        throw new Error('Live RTC staged evidence path is not confined beneath artifacts/staging.');
    }
    await createConfinedDirectories(realRepoRoot, dirname(outputPath));
    const file = await open(outputPath, 'wx');
    try {
        await file.writeFile(`${JSON.stringify(input.evidence)}\n`, 'utf8');
        await file.sync();
    }
    finally {
        await file.close();
    }
    return outputPath;
}

export async function captureLiveRtcPostGcHeap(
    pages: readonly Page[]
): Promise<number> {
    let totalUsedBytes = 0;
    for (const page of pages) {
        const session = await page.context().newCDPSession(page);
        try {
            await session.send('HeapProfiler.collectGarbage');
            const usage = await session.send('Runtime.getHeapUsage');
            const usedSize = requiredJsonRecord(
                normalizeJson(usage),
                '$.heapUsage'
            ).usedSize;
            if (typeof usedSize !== 'number' || !Number.isFinite(usedSize)) {
                throw new Error('Chromium did not return a finite post-GC heap size.');
            }
            totalUsedBytes += usedSize;
        }
        finally {
            await session.detach();
        }
    }
    return totalUsedBytes;
}

function assertAttemptIdentity(input: BuildLiveRtcExternalAttemptInput): void {
    if (input.locator.workloadId !== 'RTC-B06') {
        throw new Error('Live RTC external attempt workload must be RTC-B06.');
    }
    const sampleMismatch = attemptIdentityFields.some(
        (field) => input.sampleIdentity[field] !== input.locator[field]
    ) || input.sampleIdentity.innerOrdinal !== 1;
    if (sampleMismatch) {
        throw new Error('Live RTC sample identity does not match the attempt locator.');
    }
    const rawIdentity = input.rawEvidence.identity;
    const rawMismatch = attemptIdentityFields.some(
        (field) => rawIdentity[field] !== input.locator[field]
    ) || rawIdentity.environmentId !== input.locator.environmentId;
    if (rawMismatch) {
        throw new Error('Live RTC raw evidence identity does not match the attempt locator.');
    }
}

function assertProducerMatchesIdentity(rawEvidence: LiveRtcPerformanceRawEvidence): void {
    const e4 = rawEvidence.identity.environmentId === 'E4-pg';
    const producer = rawEvidence.producer;
    const allScenarios = rawEvidence.identity.caseId === 'all-scenarios';
    const retention = rawEvidence.identity.caseId === 'retention-100';
    if (
        producer.browserCount !== 3 ||
        producer.provider !== 'browser-rallar' ||
        producer.transports[0] !== 'realtime' ||
        producer.transports[1] !== 'messages.rtc'
    ) {
        throw new Error('Live RTC producer must use three browser-rallar agents and both RTC transports.');
    }
    if (
        (e4 && (
            producer.databaseProvider !== 'postgres' ||
            producer.databaseUrl !== 'present' ||
            producer.iceMode !== 'local' ||
            producer.iceModeRaw !== 'local'
        )) ||
        (!e4 && (
            producer.databaseProvider !== 'memory' ||
            producer.iceMode !== 'repository-default' ||
            producer.iceModeRaw !== null
        ))
    ) {
        throw new Error('Live RTC database and ICE facts do not match the environment identity.');
    }
    if (
        producer.allScenariosRaw !== (allScenarios ? '1' : null) ||
        producer.retentionSoakRaw !== (retention ? '1' : null) ||
        producer.retentionCyclesRaw !== (retention ? '100' : null)
    ) {
        throw new Error('Live RTC case selectors do not match the attempt identity.');
    }
}

function attemptIssues(input: BuildLiveRtcExternalAttemptInput): RtcBaselineIssueDto[] {
    const issues: RtcBaselineIssueDto[] = [];
    if (input.producerExitStatus !== 0) {
        issues.push({
            path: '$.producerExitStatus',
            code: 'producer-failed',
            message: `The live RTC producer exited with status ${input.producerExitStatus}.`
        });
    }
    const evidence = input.rawEvidence;
    if (!evidence.assertions.matrixPassed) {
        issues.push(assertionIssue('matrixPassed', 'The live RTC matrix assertion failed.'));
    }
    if (!evidence.assertions.artifactBundlePassed) {
        issues.push(assertionIssue('artifactBundlePassed', 'The control artifact bundle assertion failed.'));
    }
    if (evidence.assertions.unexpectedDeliveryCount !== 0) {
        issues.push(assertionIssue('unexpectedDeliveryCount', 'Unexpected RTC deliveries were observed.'));
    }
    for (const required of requiredTimingSeries(evidence.identity.caseId)) {
        if (!evidence.timings.some((timing) =>
            timing.kind === required.kind && timing.transport === required.transport
        )) {
            issues.push({
                path: '$.rawEvidence.timings',
                code: 'missing-receiver-timing',
                message:
                    `Receiver-observed ${required.kind} timing is required for ${required.transport}.`
            });
        }
    }
    if (evidence.diagnostics.length === 0) {
        issues.push({
            path: '$.rawEvidence.diagnostics',
            code: 'missing-rtc-diagnostics',
            message: 'At least one complete three-agent RTC diagnostics snapshot is required.'
        });
    }
    else if (evidence.diagnostics.some(
        (checkpoint) => checkpoint.agents.length !== 3 ||
            new Set(checkpoint.agents.map((agent) => agent.agentId)).size !== 3
    )) {
        issues.push({
            path: '$.rawEvidence.diagnostics',
            code: 'incomplete-rtc-diagnostics',
            message: 'Every RTC diagnostics checkpoint must contain three distinct browser agents.'
        });
    }
    if (evidence.identity.caseId === 'retention-100') {
        issues.push(...retentionAttemptIssues(evidence));
    }
    else if (evidence.retention !== null) {
        issues.push({
            path: '$.rawEvidence.retention',
            code: 'unexpected-retention-evidence',
            message: 'Only the retention-100 case may contain retention checkpoints.'
        });
    }
    return issues;
}

function assertionIssue(
    field: keyof LiveRtcPerformanceAssertions,
    message: string
): RtcBaselineIssueDto {
    return {
        path: `$.rawEvidence.assertions.${field}`,
        code: 'matrix-correctness-failed',
        message
    };
}

function requiredTimingSeries(
    caseId: LiveRtcPerformanceIdentity['caseId']
): readonly Readonly<{
    kind: LiveRtcPerformanceTiming['kind'];
    transport: LiveRtcPerformanceTiming['transport'];
}>[] {
    if (caseId === 'retention-100') {
        return [{ kind: 'reconnect-ready', transport: 'messages.rtc' }];
    }
    const kinds = [
        'peer-ready',
        'direct-delivery',
        'multicast-delivery',
        'broadcast-delivery'
    ] as const;
    const delivery = (['realtime', 'messages.rtc'] as const).flatMap(
        (transport) => kinds.map((kind) => ({ kind, transport }))
    );
    return caseId === 'all-scenarios'
        ? [...delivery, { kind: 'reconnect-ready', transport: 'messages.rtc' } as const]
        : delivery;
}

function retentionAttemptIssues(
    evidence: LiveRtcPerformanceRawEvidence
): RtcBaselineIssueDto[] {
    if (!evidence.retention) {
        return [{
            path: '$.rawEvidence.retention',
            code: 'missing-retention-evidence',
            message: 'The retention-100 case requires 100-cycle retention evidence.'
        }];
    }
    const cycles = evidence.retention.checkpoints.map((checkpoint) => checkpoint.cycle);
    const expectedCycles = Array.from({ length: 11 }, (_, index) => index * 10);
    const checkpointsComplete = evidence.retention.cycles === 100 &&
        JSON.stringify(cycles) === JSON.stringify(expectedCycles) &&
        evidence.retention.checkpoints.every(
            (checkpoint) =>
                checkpoint.postGcHeapBytes >= 0 &&
                checkpoint.agents.length === 3 &&
                new Set(checkpoint.agents.map((agent) => agent.agentId)).size === 3
        );
    const issues: RtcBaselineIssueDto[] = checkpointsComplete
        ? []
        : [{
            path: '$.rawEvidence.retention.checkpoints',
            code: 'invalid-retention-checkpoints',
            message: 'Retention requires cycle 0 and every tenth cycle through 100 with three distinct agents and post-GC facts.'
        }];
    const stateReturned = liveRtcRetentionStateReturned(
        evidence.retention.checkpoints
    );
    if (evidence.retention.settledStateReturned !== stateReturned) {
        issues.push({
            path: '$.rawEvidence.retention.settledStateReturned',
            code: 'retention-state-assertion-mismatch',
            message: 'The stored settled-state assertion does not match the retained checkpoints.'
        });
    }
    if (!stateReturned) {
        issues.push({
            path: '$.rawEvidence.retention.checkpoints',
            code: 'retention-state-drift',
            message: 'Settled peer, lane, count, or connection-timer state did not return to cycle 0.'
        });
    }
    return issues;
}

function producerFacts(rawEvidence: LiveRtcPerformanceRawEvidence) {
    const producer = rawEvidence.producer;
    return {
        databaseUrl: producer.databaseUrl,
        allScenariosPresent: producer.allScenariosRaw !== null,
        allScenariosRaw: producer.allScenariosRaw,
        retentionSoakPresent: producer.retentionSoakRaw !== null,
        retentionSoakRaw: producer.retentionSoakRaw,
        retentionCyclesPresent: producer.retentionCyclesRaw !== null,
        retentionCyclesRaw: producer.retentionCyclesRaw,
        iceModePresent: producer.iceModeRaw !== null,
        iceModeRaw: producer.iceModeRaw
    } as const;
}

function performanceMetrics(rawEvidence: LiveRtcPerformanceRawEvidence) {
    const timingGroups = new Map<string, number[]>();
    for (const timing of rawEvidence.timings) {
        if (!Number.isFinite(timing.durationMs) || timing.durationMs < 0) {
            throw new Error('Live RTC timing durations must be finite nonnegative numbers.');
        }
        const metric = `${timing.kind}.${timing.transport.replace('.', '-')}`;
        const values = timingGroups.get(metric) ?? [];
        values.push(timing.durationMs);
        timingGroups.set(metric, values);
    }
    const metrics = [...timingGroups].map(([metric, values]) => ({
        metric,
        unit: 'milliseconds',
        value: median(values)
    }));
    const retention = rawEvidence.retention;
    if (retention) {
        const first = retention.checkpoints[0];
        const last = retention.checkpoints.at(-1);
        if (first && last) {
            metrics.push(
                {
                    metric: 'post-gc-heap.cycle-0',
                    unit: 'bytes',
                    value: first.postGcHeapBytes
                },
                {
                    metric: 'post-gc-heap.cycle-100',
                    unit: 'bytes',
                    value: last.postGcHeapBytes
                }
            );
        }
    }
    return metrics;
}

function median(values: readonly number[]): number {
    const sorted = [...values].sort((left, right) => left - right);
    const middle = Math.floor(sorted.length / 2);
    return sorted.length % 2 === 0
        ? (sorted[middle - 1]! + sorted[middle]!) / 2
        : sorted[middle]!;
}

function sampleOutcome(sample: RtcBaselineSampleDto) {
    return {
        identity: sample.identity,
        outcome: sample.outcome,
        issues: sample.issues
    };
}

function retainedSamplesInIdentityOrder(
    input: BuildLiveRtcRetentionCohortInput
): RtcBaselineSampleDto[] {
    const samples = input.attempts.map((attempt) => {
        const sample = attempt.samples[0];
        const outcome = attempt.sampleOutcomes[0];
        const locator = attempt.locator;
        const locatorMatchesSample = sample !== undefined && attemptIdentityFields.every(
            (field) => sample.identity[field] === locator[field]
        );
        const expectedInputKey = locator.environmentId === 'E3-memory'
            ? 'e3-memory-retention-100'
            : 'e4-pg-retention-100';
        if (
            attempt.samples.length !== 1 ||
            attempt.sampleOutcomes.length !== 1 ||
            !sample ||
            !outcome ||
            !locatorMatchesSample ||
            sample.identity.innerOrdinal !== 1 ||
            outcome.identity.sampleId !== sample.identity.sampleId ||
            locator.workloadId !== 'RTC-B06' ||
            locator.caseId !== 'retention-100' ||
            locator.intendedPhase !== 'retained' ||
            locator.inputKey !== expectedInputKey ||
            input.identity.cohortId !==
                `rtc-b06-${locator.environmentId.toLowerCase()}-retention`
        ) {
            throw new Error('Live RTC retention attempts must be exact retained B06 members.');
        }
        return sample;
    });
    const sampleById = new Map(
        samples.map((sample) => [sample.identity.sampleId, sample])
    );
    if (
        new Set(input.identity.memberSampleIds).size !== input.identity.memberSampleIds.length ||
        samples.length !== input.identity.memberSampleIds.length
    ) {
        throw new Error('Live RTC retention attempts do not exactly match cohort membership.');
    }
    const ordered: RtcBaselineSampleDto[] = [];
    for (const sampleId of input.identity.memberSampleIds) {
        const sample = sampleById.get(sampleId);
        if (!sample) {
            throw new Error('Live RTC retention attempts do not exactly match cohort membership.');
        }
        ordered.push(sample);
    }
    return ordered;
}

function heapBreachThreshold(sampleCount: number): number {
    if (sampleCount === 3) {
        return 2;
    }
    if (sampleCount === 6) {
        return 4;
    }
    throw new Error('Live RTC retention cohort requires exactly 3 primary or 6 repeat samples.');
}

function retentionHeapBreached(sample: RtcBaselineSampleDto): boolean {
    const retention = retentionEvidence(sample);
    if (!retention) {
        return false;
    }
    const cycle0 = retention.checkpoints[0]?.postGcHeapBytes;
    const final = retention.checkpoints.at(-1)?.postGcHeapBytes;
    return cycle0 !== undefined && final !== undefined &&
        final > cycle0 * 1.1 && final > cycle0 + FIVE_MEBIBYTES;
}

function retentionStateDrifted(sample: RtcBaselineSampleDto): boolean {
    const retention = retentionEvidence(sample);
    return !retention ||
        !retention.settledStateReturned ||
        !liveRtcRetentionStateReturned(retention.checkpoints);
}

export function liveRtcRetentionStateReturned(
    checkpoints: readonly LiveRtcRetentionCheckpoint[]
): boolean {
    const first = checkpoints[0];
    if (!first) {
        return false;
    }
    const firstAgentIds = first.agents.map((agent) => agent.agentId).sort();
    return checkpoints.every((checkpoint) => {
        const checkpointAgentIds = checkpoint.agents
            .map((agent) => agent.agentId)
            .sort();
        return checkpoint.agents.length === first.agents.length &&
            JSON.stringify(checkpointAgentIds) === JSON.stringify(firstAgentIds) &&
            first.agents.every((agent) => {
                const observed = checkpoint.agents.find(
                    (candidate) => candidate.agentId === agent.agentId
                );
                return observed !== undefined &&
                    JSON.stringify(stableAgentState(observed)) ===
                        JSON.stringify(stableAgentState(agent));
            });
    });
}

function retentionEvidence(sample: RtcBaselineSampleDto): LiveRtcRetentionEvidence | null {
    const raw = jsonRecord(sample.rawEvidence);
    if (!raw) {
        return null;
    }
    const retention = jsonRecord(raw.retention);
    if (
        !retention ||
        retention.cycles !== 100 ||
        typeof retention.settledStateReturned !== 'boolean' ||
        !Array.isArray(retention.checkpoints)
    ) {
        return null;
    }
    const checkpoints: LiveRtcRetentionCheckpoint[] = [];
    for (const value of retention.checkpoints) {
        const checkpoint = decodeRetentionCheckpoint(value);
        if (!checkpoint) {
            return null;
        }
        checkpoints.push(checkpoint);
    }
    return {
        cycles: 100,
        checkpoints,
        settledStateReturned: retention.settledStateReturned
    };
}

function stableAgentState(agent: LiveRtcAgentDiagnostics) {
    return {
        settledPeerIds: [...agent.settledPeerIds].sort(),
        readyPeerIds: [...agent.readyPeerIds].sort(),
        laneStates: [...agent.laneStates].sort(compareLaneStates),
        connectionTimerActive: agent.connectionTimerActive,
        peerCount: agent.peerCount,
        connectedPeerCount: agent.connectedPeerCount,
        relayPeerCount: agent.relayPeerCount
    };
}

function decodeRetentionCheckpoint(
    value: RtcBaselineJson
): LiveRtcRetentionCheckpoint | null {
    const checkpoint = jsonRecord(value);
    if (
        !checkpoint ||
        !isFiniteNonnegativeNumber(checkpoint.cycle) ||
        !isFiniteNonnegativeNumber(checkpoint.postGcHeapBytes) ||
        !Array.isArray(checkpoint.agents)
    ) {
        return null;
    }
    const agents: LiveRtcAgentDiagnostics[] = [];
    for (const agentValue of checkpoint.agents) {
        const agent = decodeAgentDiagnostics(agentValue);
        if (!agent) {
            return null;
        }
        agents.push(agent);
    }
    return {
        cycle: checkpoint.cycle,
        postGcHeapBytes: checkpoint.postGcHeapBytes,
        agents
    };
}

function decodeAgentDiagnostics(
    value: RtcBaselineJson
): LiveRtcAgentDiagnostics | null {
    const agent = jsonRecord(value);
    const settledPeerIds = agent ? exactStringArray(agent.settledPeerIds) : null;
    const readyPeerIds = agent ? exactStringArray(agent.readyPeerIds) : null;
    if (
        !agent ||
        typeof agent.agentId !== 'string' ||
        !settledPeerIds ||
        !readyPeerIds ||
        !Array.isArray(agent.laneStates) ||
        typeof agent.connectionTimerActive !== 'boolean' ||
        !isFiniteNonnegativeNumber(agent.peerCount) ||
        !isFiniteNonnegativeNumber(agent.connectedPeerCount) ||
        !isFiniteNonnegativeNumber(agent.relayPeerCount) ||
        agent.details === undefined
    ) {
        return null;
    }
    const laneStates: LiveRtcLaneDiagnostics[] = [];
    for (const laneValue of agent.laneStates) {
        const lane = decodeLaneDiagnostics(laneValue);
        if (!lane) {
            return null;
        }
        laneStates.push(lane);
    }
    return {
        agentId: agent.agentId,
        settledPeerIds,
        readyPeerIds,
        laneStates,
        connectionTimerActive: agent.connectionTimerActive,
        peerCount: agent.peerCount,
        connectedPeerCount: agent.connectedPeerCount,
        relayPeerCount: agent.relayPeerCount,
        details: agent.details
    };
}

function decodeLaneDiagnostics(
    value: RtcBaselineJson
): LiveRtcLaneDiagnostics | null {
    const lane = jsonRecord(value);
    return lane &&
        typeof lane.peerId === 'string' &&
        typeof lane.laneId === 'string' &&
        typeof lane.isOpen === 'boolean' &&
        typeof lane.isReconnectable === 'boolean'
        ? {
            peerId: lane.peerId,
            laneId: lane.laneId,
            isOpen: lane.isOpen,
            isReconnectable: lane.isReconnectable
        }
        : null;
}

function jsonRecord(
    value: RtcBaselineJson | undefined
): { [key: string]: RtcBaselineJson; } | null {
    return value !== undefined &&
        typeof value === 'object' &&
        value !== null &&
        !Array.isArray(value)
        ? value
        : null;
}

function exactStringArray(value: RtcBaselineJson | undefined): readonly string[] | null {
    return Array.isArray(value) &&
        value.every((entry): entry is string => typeof entry === 'string')
        ? value
        : null;
}

function isFiniteNonnegativeNumber(
    value: RtcBaselineJson | undefined
): value is number {
    return typeof value === 'number' && Number.isFinite(value) && value >= 0;
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

function optionalJsonArray(
    value: RtcBaselineJson | undefined,
    path: string
): readonly RtcBaselineJson[] {
    return value === undefined ? [] : requiredJsonArray(value, path);
}

function optionalString(
    value: RtcBaselineJson | undefined,
    path: string
): string | undefined {
    return value === undefined ? undefined : requiredString(value, path);
}

function stringValue(value: RtcBaselineJson | undefined): string | undefined {
    return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function numberValue(value: RtcBaselineJson | undefined): number | undefined {
    return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function stringArrayValue(value: RtcBaselineJson | undefined): readonly string[] {
    return Array.isArray(value)
        ? value.filter((entry): entry is string => typeof entry === 'string')
        : [];
}

function runtimeEventPayload(
    event: LiveRtcControlClient.Event
): { [key: string]: RtcBaselineJson; } {
    const payload = jsonRecord(event.payload) ?? {};
    return typeof payload.kind === 'string'
        ? payload
        : jsonRecord(payload.payload) ?? payload;
}

function messageData(
    event: LiveRtcControlClient.Event
): { [key: string]: RtcBaselineJson; } {
    const runtimeEvent = runtimeEventPayload(event);
    const runtimePayload = jsonRecord(runtimeEvent.payload) ?? {};
    return jsonRecord(runtimePayload.data ?? runtimeEvent.data) ?? {};
}

export function countUnexpectedLiveRtcDeliveries(input: Readonly<{
    events: readonly LiveRtcControlClient.Event[];
    scenarios: readonly LiveRtcControlClient.DeliveryScenario[];
}>): number {
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

export function buildLiveRtcAgentDiagnostics(
    agentId: string,
    resultValue: RtcBaselineJson | object
): LiveRtcAgentDiagnostics {
    const normalized = normalizeJson(resultValue);
    const root = requiredJsonRecord(normalized, '$');
    const rallar = requiredJsonRecord(root.rallar, '$.rallar');
    const status = requiredJsonRecord(rallar.rtcStatus, '$.rallar.rtcStatus');
    const diagnostics = requiredJsonRecord(
        rallar.rtcDiagnostics,
        '$.rallar.rtcDiagnostics'
    );
    const settledPeerIds = requiredStringArray(
        status.activePeerIds,
        '$.rallar.rtcStatus.activePeerIds'
    ).sort();
    const readyPeerIds = requiredStringArray(
        status.readyPeerIds,
        '$.rallar.rtcStatus.readyPeerIds'
    ).sort();
    const peers = requiredJsonArray(
        diagnostics.peers,
        '$.rallar.rtcDiagnostics.peers'
    );
    const peerRecords = peers.map((peer, index) =>
        requiredJsonRecord(peer, `$.rallar.rtcDiagnostics.peers[${index}]`)
    );
    const laneStates = peerRecords.flatMap((peer) => {
        const peerId = requiredString(peer.peerId, 'RTC diagnostic peerId');
        const lanes = requiredJsonArray(peer.lanes, `RTC diagnostic lanes for ${peerId}`);
        return lanes.map((laneValue, index) => {
            const lane = requiredJsonRecord(
                laneValue,
                `RTC diagnostic lane ${index} for ${peerId}`
            );
            return {
                peerId,
                laneId: requiredString(lane.laneId, `RTC diagnostic laneId for ${peerId}`),
                isOpen: requiredBoolean(lane.isOpen, `RTC diagnostic isOpen for ${peerId}`),
                isReconnectable: requiredBoolean(
                    lane.isReconnectable,
                    `RTC diagnostic isReconnectable for ${peerId}`
                )
            };
        });
    }).sort(compareLaneStates);
    const connectionTimerActive = peerRecords.some((peer) => {
        const connection = requiredJsonRecord(
            peer.connection,
            'RTC diagnostic peer connection'
        );
        const connectionDiagnostics = jsonRecord(peer.connectionDiagnostics);
        return connection.disconnectPending === true ||
            connection.reconnecting === true ||
            connectionDiagnostics?.hasReconnectTimer === true ||
            (numberValue(connectionDiagnostics?.reconnectAttemptsInFlight) ?? 0) !== 0;
    });
    return {
        agentId,
        settledPeerIds,
        readyPeerIds,
        laneStates,
        connectionTimerActive,
        peerCount: requiredNonnegativeNumber(diagnostics.peerCount, 'RTC peerCount'),
        connectedPeerCount: requiredNonnegativeNumber(
            diagnostics.connectedPeerCount,
            'RTC connectedPeerCount'
        ),
        relayPeerCount: requiredNonnegativeNumber(
            diagnostics.relayPeerCount,
            'RTC relayPeerCount'
        ),
        details: normalizeJson({
            sessionId: diagnostics.sessionId ?? null,
            generatedAtEpochMs: diagnostics.generatedAtEpochMs,
            status,
            diagnostics,
            rtcDiagnosticsError: rallar.rtcDiagnosticsError ?? null
        })
    };
}

function compareLaneStates(
    left: LiveRtcLaneDiagnostics,
    right: LiveRtcLaneDiagnostics
): number {
    return left.peerId.localeCompare(right.peerId) ||
        left.laneId.localeCompare(right.laneId);
}

function requiredJsonRecord(
    value: RtcBaselineJson | undefined,
    path: string
): { [key: string]: RtcBaselineJson; } {
    const record = jsonRecord(value);
    if (!record) {
        throw new Error(`${path} must be a JSON object.`);
    }
    return record;
}

function requiredJsonArray(
    value: RtcBaselineJson | undefined,
    path: string
): readonly RtcBaselineJson[] {
    if (!Array.isArray(value)) {
        throw new Error(`${path} must be a JSON array.`);
    }
    return value;
}

function requiredStringArray(
    value: RtcBaselineJson | undefined,
    path: string
): string[] {
    const values = exactStringArray(value);
    if (!values) {
        throw new Error(`${path} must contain only strings.`);
    }
    return [...values];
}

function requiredString(value: RtcBaselineJson | undefined, field: string): string {
    if (typeof value !== 'string' || value.length === 0) {
        throw new Error(`${field} must be a nonempty string.`);
    }
    return value;
}

function requiredBoolean(value: RtcBaselineJson | undefined, field: string): boolean {
    if (typeof value !== 'boolean') {
        throw new Error(`${field} must be boolean.`);
    }
    return value;
}

function requiredNonnegativeNumber(
    value: RtcBaselineJson | undefined,
    field: string
): number {
    if (!isFiniteNonnegativeNumber(value)) {
        throw new Error(`${field} must be a finite nonnegative number.`);
    }
    return value;
}

function safeFileName(value: string): string {
    return value.replace(/[^a-zA-Z0-9_.-]+/g, '-');
}

function normalizeJson(value: RtcBaselineJson | object): RtcBaselineJson {
    assertJsonValue(value, '$');
    return JSON.parse(JSON.stringify(value)) as RtcBaselineJson;
}

function assertJsonValue(value: RtcBaselineJson | object, path: string): void {
    if (value === null || typeof value === 'string' || typeof value === 'boolean') {
        return;
    }
    if (typeof value === 'number') {
        if (!Number.isFinite(value)) {
            throw new Error(`${path} contains a non-finite number.`);
        }
        return;
    }
    if (Array.isArray(value)) {
        for (let index = 0; index < value.length; index += 1) {
            if (!(index in value)) {
                throw new Error(`${path}[${index}] is a sparse array entry.`);
            }
            assertJsonValue(value[index], `${path}[${index}]`);
        }
        return;
    }
    if (typeof value !== 'object' || Object.getPrototypeOf(value) !== Object.prototype) {
        throw new Error(`${path} is not a plain JSON value.`);
    }
    for (const [field, entry] of Object.entries(value)) {
        if (entry === undefined) {
            throw new Error(`${path}.${field} is undefined.`);
        }
        assertJsonValue(entry, `${path}.${field}`);
    }
}

async function createConfinedDirectories(
    root: string,
    targetDirectory: string
): Promise<void> {
    const targetRelativePath = relative(root, targetDirectory);
    if (
        targetRelativePath === '..' ||
        targetRelativePath.startsWith(`..${sep}`) ||
        isAbsolute(targetRelativePath)
    ) {
        throw new Error('Live RTC evidence directory is not confined to the repository root.');
    }
    let current = root;
    for (const segment of targetRelativePath.split(sep).filter(Boolean)) {
        current = resolve(current, segment);
        try {
            const metadata = await lstat(current);
            if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
                throw new Error(`Live RTC evidence directory component is unsafe: ${current}`);
            }
        }
        catch (error) {
            if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) {
                throw error;
            }
            await mkdir(current);
        }
    }
}

function assertValidBuiltEvidence(issues: readonly RtcBaselineIssueDto[]): void {
    if (issues.length > 0) {
        throw new Error(`Live RTC evidence builder produced an invalid contract: ${JSON.stringify(issues)}`);
    }
}

function assertCanonicalLiveRtcBaselineId(baselineId: string): void {
    if (!LIVE_RTC_BASELINE_ID.test(baselineId)) {
        throw new Error('Live RTC evidence requires a canonical E3-memory or E4-pg baseline ID.');
    }
}

async function readBaselineManifest(baselineRoot: string) {
    const value = normalizeJson(JSON.parse(
        await readFile(resolve(baselineRoot, 'manifest.json'), 'utf8')
    ));
    const decoded = decodeRtcBaselineManifest(value);
    if (!decoded.ok) {
        throw new Error(`Live RTC manifest is invalid: ${JSON.stringify(decoded.issues)}`);
    }
    return decoded.value;
}

async function readBaselineEnvironment(
    baselineRoot: string
): Promise<RtcBaselineEnvironmentDto> {
    const value = normalizeJson(JSON.parse(
        await readFile(resolve(baselineRoot, 'environment.json'), 'utf8')
    ));
    const decoded = decodeRtcBaselineEnvironment(value);
    if (!decoded.ok) {
        throw new Error(`Live RTC environment is invalid: ${JSON.stringify(decoded.issues)}`);
    }
    return decoded.value;
}

async function readExternalAttempt(path: string): Promise<RtcBaselineExternalAttemptDto> {
    const value = normalizeJson(JSON.parse(await readFile(path, 'utf8')));
    const decoded = decodeRtcBaselineExternalAttempt(value);
    if (!decoded.ok) {
        throw new Error(`Live RTC external attempt is invalid: ${JSON.stringify(decoded.issues)}`);
    }
    return decoded.value;
}
