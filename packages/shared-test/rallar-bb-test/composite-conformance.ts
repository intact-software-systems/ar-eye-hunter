import {
    summarizeRallarBlackBoxCompositeResults,
    type RallarBlackBoxCompositeResultSummary,
} from './composite-results.ts';
import { redactRallarBlackBoxValue } from './redaction.ts';
import {
    createRallarBlackBoxCompositeConformanceRecipe,
} from './conformance/create-rallar-black-box-composite-conformance-recipe.ts';
import type {
    RallarBlackBoxTestCommand,
    RallarBlackBoxTestEvent,
    RallarBlackBoxTestRecipe,
    RallarBlackBoxTestRedactionOptions,
    RallarBlackBoxTestResult,
    RallarBlackBoxTestResultStatus,
    RallarBlackBoxTestState,
    RallarBlackBoxTestTransport,
} from './types.ts';

export type RallarBlackBoxCompositeConformanceCaseId =
    | 'looped-rtc-send'
    | 'parallel-ws-rtc-groups'
    | 'wait-assert-evidence'
    | 'cancel-during-loop'
    | 'wait-absence-hold'
    | 'wait-absence-violated'
    | 'assert-shape-complete-violated'
    | 'negative-no-peer';

export type RallarBlackBoxCompositeConformanceProviderId =
    | 'in-memory-local'
    | 'browser-rallar'
    | 'remote-browser-control';

export type RallarBlackBoxCompositeConformanceRequirement = Readonly<{
    env?: readonly string[];
    httpServices?: readonly Readonly<{
        name: string;
        env: string;
        default?: string;
    }>[];
    playwright?: boolean;
    controlServer?: boolean;
}>;

export type RallarBlackBoxCompositeConformanceCase = Readonly<{
    caseId: RallarBlackBoxCompositeConformanceCaseId;
    title: string;
    intent: string;
    expectedStatus: RallarBlackBoxTestResultStatus;
    requiredCommandKinds: readonly RallarBlackBoxTestCommand['kind'][];
    requiredCompositeKinds: readonly Extract<RallarBlackBoxTestCommand['kind'], 'loop' | 'parallel'>[];
    requiredEventTopics?: readonly string[];
    expectedFailureCodes?: readonly string[];
    liveSafe: boolean;
}>;

export type RallarBlackBoxCompositeConformanceProvider = Readonly<{
    providerId: RallarBlackBoxCompositeConformanceProviderId;
    title: string;
    mode: 'deterministic' | 'live-gated';
    runtimeSurface: 'local-runtime' | 'browser-adapter' | 'control-server';
    supportedCaseIds: readonly RallarBlackBoxCompositeConformanceCaseId[];
    requires?: RallarBlackBoxCompositeConformanceRequirement;
    capabilityDifferences: readonly string[];
}>;

export type RallarBlackBoxCompositeConformanceRecipeOptions = Readonly<{
    recipeIdPrefix?: string;
    runId?: string;
    agentId?: string;
    environment?: string;
    apiBaseUrl?: string;
    actor?: string;
    sessionId?: string;
    roomId?: string;
    connection?: string;
    wsConnection?: string;
    transport?: Extract<RallarBlackBoxTestTransport, 'realtime' | 'messages.rtc'>;
    providerMode?: 'simulated' | 'browser-rallar' | 'rallar-remote-browser';
    timeoutMs?: number;
    applicationId?: string;
    workspaceId?: string;
}>;

export type RallarBlackBoxCompositeConformanceMatrixEntry = Readonly<{
    entryId: string;
    artifactName: string;
    caseId: RallarBlackBoxCompositeConformanceCaseId;
    providerId: RallarBlackBoxCompositeConformanceProviderId;
    mode: 'deterministic' | 'live-gated';
    supported: boolean;
    skipReason?: string;
    case: RallarBlackBoxCompositeConformanceCase;
    provider: RallarBlackBoxCompositeConformanceProvider;
    recipe: RallarBlackBoxTestRecipe;
    requires?: RallarBlackBoxCompositeConformanceRequirement;
}>;

export type RallarBlackBoxCompositeConformanceReport = Readonly<{
    schemaVersion: 1;
    entryId: string;
    artifactName: string;
    caseId: RallarBlackBoxCompositeConformanceCaseId;
    providerId: RallarBlackBoxCompositeConformanceProviderId;
    status: 'passed' | 'failed' | 'skipped';
    skipReason?: string;
    expected: Readonly<{
        resultStatus: RallarBlackBoxTestResultStatus;
        requiredCommandKinds: readonly RallarBlackBoxTestCommand['kind'][];
        requiredCompositeKinds: readonly Extract<RallarBlackBoxTestCommand['kind'], 'loop' | 'parallel'>[];
        requiredEventTopics: readonly string[];
        expectedFailureCodes: readonly string[];
    }>;
    observed?: Readonly<{
        resultStatus: RallarBlackBoxTestResultStatus;
        ok: boolean;
        commandIds: readonly string[];
        commandKinds: readonly RallarBlackBoxTestCommand['kind'][];
        eventTopics: readonly string[];
        diagnostics: number;
        failures: number;
        compositeSummary?: RallarBlackBoxCompositeResultSummary;
        failureCodes: readonly string[];
    }>;
    capabilityDifferences: readonly string[];
    diagnostics?: readonly unknown[];
    redactedFailures?: readonly unknown[];
}>;

export const RALLAR_BLACK_BOX_COMPOSITE_CONFORMANCE_CASES:
    readonly RallarBlackBoxCompositeConformanceCase[] = [
        {
            caseId: 'looped-rtc-send',
            title: 'Looped RTC Send',
            intent: 'Prove loop cadence, send summaries, stats, and cleanup for repeated RTC traffic.',
            expectedStatus: 'ok',
            requiredCommandKinds: ['configure', 'rtc.connect', 'loop', 'rtc.send', 'stats', 'close'],
            requiredCompositeKinds: ['loop'],
            requiredEventTopics: ['rallar.bb.rtc.connected', 'rallar.conformance.message'],
            liveSafe: true,
        },
        {
            caseId: 'parallel-ws-rtc-groups',
            title: 'Parallel WS And RTC Groups',
            intent: 'Prove bounded parallel groups can mix WS and RTC send branches.',
            expectedStatus: 'ok',
            requiredCommandKinds: [
                'configure',
                'ws.open',
                'rtc.connect',
                'parallel',
                'ws.send',
                'rtc.send',
                'stats',
                'ws.close',
                'close',
            ],
            requiredCompositeKinds: ['parallel'],
            requiredEventTopics: ['rallar.bb.ws.message', 'rallar.conformance.message'],
            liveSafe: true,
        },
        {
            caseId: 'wait-assert-evidence',
            title: 'Wait And Assert Evidence',
            intent: 'Prove send, wait, and assert commands use the same runtime evidence contract.',
            expectedStatus: 'ok',
            requiredCommandKinds: ['configure', 'rtc.connect', 'rtc.send', 'wait', 'assert', 'stats', 'close'],
            requiredCompositeKinds: [],
            requiredEventTopics: ['rallar.conformance.message'],
            liveSafe: true,
        },
        {
            caseId: 'cancel-during-loop',
            title: 'Cancellation During Loop',
            intent: 'Prove cancellation propagates through a looped recipe and yields partial evidence.',
            expectedStatus: 'cancelled',
            requiredCommandKinds: ['configure', 'loop', 'health', 'recipe.cancel'],
            requiredCompositeKinds: ['loop'],
            liveSafe: true,
        },
        {
            caseId: 'wait-absence-hold',
            title: 'Wait Absence Hold',
            intent: 'Prove an absence wait holds the full window and passes when nothing matches.',
            expectedStatus: 'ok',
            requiredCommandKinds: [
                'configure',
                'rtc.connect',
                'rtc.send',
                'wait',
                'stats',
                'close',
            ],
            requiredCompositeKinds: [],
            requiredEventTopics: ['rallar.conformance.message'],
            liveSafe: true,
        },
        {
            caseId: 'wait-absence-violated',
            title: 'Wait Absence Violated Control',
            intent: 'Prove a deliberately-broken absence wait fails with the offending redacted event.',
            expectedStatus: 'failed',
            requiredCommandKinds: ['configure', 'rtc.connect', 'rtc.send', 'wait'],
            requiredCompositeKinds: [],
            requiredEventTopics: ['rallar.conformance.message'],
            expectedFailureCodes: ['RALLAR_BLACK_BOX_WAIT_ABSENCE_VIOLATED'],
            liveSafe: true,
        },
        {
            caseId: 'assert-shape-complete-violated',
            title: 'Assert Shape Complete Violated Control',
            intent: 'Prove matchesShapeComplete rejects an unexpected array element with a failed assert.',
            expectedStatus: 'failed',
            requiredCommandKinds: ['configure', 'rtc.connect', 'rtc.send', 'wait', 'assert'],
            requiredCompositeKinds: [],
            requiredEventTopics: ['rallar.conformance.message'],
            expectedFailureCodes: ['RALLAR_BLACK_BOX_ASSERT_FAILED'],
            liveSafe: true,
        },
        {
            caseId: 'negative-no-peer',
            title: 'No-peer Negative Case',
            intent: 'Prove delivery failure is reported separately from local composite orchestration.',
            expectedStatus: 'failed',
            requiredCommandKinds: ['configure', 'rtc.connect', 'rtc.send'],
            requiredCompositeKinds: [],
            requiredEventTopics: ['rallar.bb.rtc.send_failed'],
            expectedFailureCodes: ['RALLAR_BB_RTC_NO_PEERS'],
            liveSafe: true,
        },
    ] as const;

export const RALLAR_BLACK_BOX_COMPOSITE_CONFORMANCE_PROVIDERS:
    readonly RallarBlackBoxCompositeConformanceProvider[] = [
        {
            providerId: 'in-memory-local',
            title: 'In-memory local browser-agent runtime',
            mode: 'deterministic',
            runtimeSurface: 'local-runtime',
            supportedCaseIds: [
                'looped-rtc-send',
                'parallel-ws-rtc-groups',
                'wait-assert-evidence',
                'cancel-during-loop',
                'wait-absence-hold',
                'wait-absence-violated',
                'assert-shape-complete-violated',
                'negative-no-peer',
            ],
            capabilityDifferences: [
                'Uses deterministic fake transport evidence; no browser WebRTC stack is opened.',
            ],
        },
        {
            providerId: 'browser-rallar',
            title: 'Browser Rallar runtime',
            mode: 'live-gated',
            runtimeSurface: 'browser-adapter',
            supportedCaseIds: [
                'looped-rtc-send',
                'parallel-ws-rtc-groups',
                'wait-assert-evidence',
                'cancel-during-loop',
                'wait-absence-hold',
                'wait-absence-violated',
                'assert-shape-complete-violated',
                'negative-no-peer',
            ],
            requires: {
                env: [
                    'RALLAR_API_BASE_URL',
                    'RALLAR_ALICE_USERNAME',
                    'RALLAR_ALICE_PASSWORD',
                    'RALLAR_BOB_USERNAME',
                    'RALLAR_BOB_PASSWORD',
                ],
                httpServices: [
                    {
                        name: 'Rallar API',
                        env: 'RALLAR_API_BASE_URL',
                        default: 'http://localhost:8080',
                    },
                ],
                playwright: true,
            },
            capabilityDifferences: [
                'Uses browser adapter diagnostics and real browser transport readiness.',
                'Timing thresholds should stay broad because browser scheduling is host-dependent.',
            ],
        },
        {
            providerId: 'remote-browser-control',
            title: 'Remote browser through control server',
            mode: 'live-gated',
            runtimeSurface: 'control-server',
            supportedCaseIds: [
                'looped-rtc-send',
                'parallel-ws-rtc-groups',
                'wait-assert-evidence',
                'cancel-during-loop',
                'wait-absence-hold',
                'wait-absence-violated',
                'assert-shape-complete-violated',
                'negative-no-peer',
            ],
            requires: {
                env: [
                    'RALLAR_API_BASE_URL',
                    'RALLAR_ALICE_USERNAME',
                    'RALLAR_ALICE_PASSWORD',
                    'RALLAR_BOB_USERNAME',
                    'RALLAR_BOB_PASSWORD',
                    'RALLAR_BLACK_BOX_CONTROL_BASE_URL',
                    'RALLAR_BLACK_BOX_AGENT_ID',
                ],
                httpServices: [
                    {
                        name: 'Rallar API',
                        env: 'RALLAR_API_BASE_URL',
                        default: 'http://localhost:8080',
                    },
                    {
                        name: 'Rallar black-box control server',
                        env: 'RALLAR_BLACK_BOX_CONTROL_BASE_URL',
                        default: 'http://localhost:5180',
                    },
                ],
                controlServer: true,
            },
            capabilityDifferences: [
                'Adds control-server queueing and polling latency to command timing.',
                'Artifacts should retain control-run IDs and agent IDs for join-key lookup.',
            ],
        },
    ] as const;

export function rallarBlackBoxCompositeConformanceCaseById(
    caseId: RallarBlackBoxCompositeConformanceCaseId,
): RallarBlackBoxCompositeConformanceCase {
    const found = RALLAR_BLACK_BOX_COMPOSITE_CONFORMANCE_CASES
        .find(entry => entry.caseId === caseId);
    if (!found) {
        throw new Error(`Unknown composite conformance case: ${caseId}`);
    }
    return found;
}

export function rallarBlackBoxCompositeConformanceProviderById(
    providerId: RallarBlackBoxCompositeConformanceProviderId,
): RallarBlackBoxCompositeConformanceProvider {
    const found = RALLAR_BLACK_BOX_COMPOSITE_CONFORMANCE_PROVIDERS
        .find(entry => entry.providerId === providerId);
    if (!found) {
        throw new Error(`Unknown composite conformance provider: ${providerId}`);
    }
    return found;
}

export function createRallarBlackBoxCompositeConformanceMatrix(
    options: Readonly<{
        caseIds?: readonly RallarBlackBoxCompositeConformanceCaseId[];
        providerIds?: readonly RallarBlackBoxCompositeConformanceProviderId[];
        recipeOptions?: RallarBlackBoxCompositeConformanceRecipeOptions;
    }> = {},
): readonly RallarBlackBoxCompositeConformanceMatrixEntry[] {
    const cases = (options.caseIds ?? RALLAR_BLACK_BOX_COMPOSITE_CONFORMANCE_CASES.map(entry => entry.caseId))
        .map(rallarBlackBoxCompositeConformanceCaseById);
    const providers = (options.providerIds ?? RALLAR_BLACK_BOX_COMPOSITE_CONFORMANCE_PROVIDERS.map(entry => entry.providerId))
        .map(rallarBlackBoxCompositeConformanceProviderById);

    return providers.flatMap(provider =>
        cases.map(testCase => {
            const supported = provider.supportedCaseIds.includes(testCase.caseId);
            const entryId = `${provider.providerId}:${testCase.caseId}`;
            return {
                entryId,
                artifactName: entryId.replace(/:/g, '-'),
                caseId: testCase.caseId,
                providerId: provider.providerId,
                mode: provider.mode,
                supported,
                skipReason: supported
                    ? undefined
                    : `${provider.providerId} does not support ${testCase.caseId}.`,
                case: testCase,
                provider,
                recipe: createRallarBlackBoxCompositeConformanceRecipe(testCase.caseId, {
                    providerMode: provider.providerId === 'browser-rallar'
                        ? 'browser-rallar'
                        : provider.providerId === 'remote-browser-control'
                            ? 'rallar-remote-browser'
                            : 'simulated',
                    ...(options.recipeOptions ?? {}),
                }),
                requires: provider.requires,
            } satisfies RallarBlackBoxCompositeConformanceMatrixEntry;
        })
    );
}

export function toRallarBlackBoxCompositeConformanceReport(
    entry: RallarBlackBoxCompositeConformanceMatrixEntry,
    input: Readonly<{
        result?: RallarBlackBoxTestResult;
        state?: RallarBlackBoxTestState;
        skipReason?: string;
        redaction?: RallarBlackBoxTestRedactionOptions;
    }> = {},
): RallarBlackBoxCompositeConformanceReport {
    if (!entry.supported || input.skipReason) {
        return {
            schemaVersion: 1,
            entryId: entry.entryId,
            artifactName: entry.artifactName,
            caseId: entry.caseId,
            providerId: entry.providerId,
            status: 'skipped',
            skipReason: input.skipReason ?? entry.skipReason,
            expected: expectedReport(entry.case),
            capabilityDifferences: entry.provider.capabilityDifferences,
        };
    }

    const result = input.result;
    const state = input.state;
    const commandHistory = state?.commandHistory ?? (result ? [result] : []);
    const eventTopics = (state?.events ?? []).map(event => event.topic);
    const diagnostics = (state?.events ?? []).filter(event => event.kind === 'diagnostic');
    const failures = state?.failures ?? commandHistory.filter(commandResult => !commandResult.ok);
    const failureCodes = collectFailureCodes(result, failures);
    const compositeResults = commandHistory.filter(isCompositeResult);
    const observed = result
        ? {
            resultStatus: result.status,
            ok: result.ok,
            commandIds: commandHistory.map(commandResult => commandResult.commandId),
            commandKinds: commandHistory.map(commandResult => commandResult.kind),
            eventTopics,
            diagnostics: diagnostics.length,
            failures: failures.length,
            compositeSummary: compositeResults.length > 0
                ? summarizeRallarBlackBoxCompositeResults(compositeResults, {
                    redaction: input.redaction,
                })
                : undefined,
            failureCodes,
        }
        : undefined;

    const passed = Boolean(
        observed &&
            observed.resultStatus === entry.case.expectedStatus &&
            containsAll(observed.commandKinds, entry.case.requiredCommandKinds) &&
            containsAll(
                observed.commandKinds,
                entry.case.requiredCompositeKinds,
            ) &&
            containsAll(observed.eventTopics, entry.case.requiredEventTopics ?? []) &&
            containsAll(observed.failureCodes, entry.case.expectedFailureCodes ?? []),
    );

    return {
        schemaVersion: 1,
        entryId: entry.entryId,
        artifactName: entry.artifactName,
        caseId: entry.caseId,
        providerId: entry.providerId,
        status: passed ? 'passed' : 'failed',
        expected: expectedReport(entry.case),
        observed,
        capabilityDifferences: entry.provider.capabilityDifferences,
        diagnostics: diagnostics.map(event => redactDiagnostic(event, input.redaction)),
        redactedFailures: failures.map(failure => redactRallarBlackBoxValue(failure, input.redaction)),
    };
}

function expectedReport(
    testCase: RallarBlackBoxCompositeConformanceCase,
): RallarBlackBoxCompositeConformanceReport['expected'] {
    return {
        resultStatus: testCase.expectedStatus,
        requiredCommandKinds: testCase.requiredCommandKinds,
        requiredCompositeKinds: testCase.requiredCompositeKinds,
        requiredEventTopics: testCase.requiredEventTopics ?? [],
        expectedFailureCodes: testCase.expectedFailureCodes ?? [],
    };
}

function containsAll<T>(actual: readonly T[], expected: readonly T[]): boolean {
    return expected.every(value => actual.includes(value));
}

function isCompositeResult(result: RallarBlackBoxTestResult): boolean {
    return result.kind === 'loop' || result.kind === 'parallel';
}

function collectFailureCodes(
    result: RallarBlackBoxTestResult | undefined,
    failures: readonly RallarBlackBoxTestResult[],
): readonly string[] {
    const values = [
        result?.error,
        ...failures.map(failure => failure.error),
    ];
    const codes = new Set<string>();
    values.forEach(error => collectErrorCodes(error, codes));
    return [...codes].sort();
}

function collectErrorCodes(value: unknown, codes: Set<string>): void {
    if (!value || typeof value !== 'object') {
        return;
    }
    const record = value as Record<string, unknown>;
    if (typeof record.code === 'string') {
        codes.add(record.code);
    }
    Object.values(record).forEach(entry => collectErrorCodes(entry, codes));
}

function redactDiagnostic(
    event: RallarBlackBoxTestEvent,
    redaction: RallarBlackBoxTestRedactionOptions | undefined,
): unknown {
    return redactRallarBlackBoxValue({
        topic: event.topic,
        commandId: event.commandId,
        severity: event.severity,
        payload: event.payload,
    }, redaction);
}
