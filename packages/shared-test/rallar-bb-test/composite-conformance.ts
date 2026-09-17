import {
    computeRallarBlackBoxCompositeResultSummary,
    type RallarBlackBoxCompositeResultSummary
} from './composite-results.ts';
import {
    createRallarBlackBoxCompositeConformanceRecipe
} from './conformance/create-rallar-black-box-composite-conformance-recipe.ts';
import type {
    RallarBlackBoxTestCommand,
    RallarBlackBoxTestEvent,
    RallarBlackBoxTestRecipe,
    RallarBlackBoxTestRedactionOptions,
    RallarBlackBoxTestResult,
    RallarBlackBoxTestResultStatus,
    RallarBlackBoxTestState,
    RallarBlackBoxTestTransport
} from './rallar-black-box-test-contracts.ts';
import { redactRallarBlackBoxValue } from './redaction.ts';
import { isJsonRecordValue } from './schema/json-schema-validation.ts';

export type RallarBlackBoxCompositeConformanceCaseId =
    | 'looped-rtc-send'
    | 'parallel-ws-rtc-groups'
    | 'wait-assert-evidence'
    | 'cancel-during-loop'
    | 'wait-absence-hold'
    | 'wait-absence-violated'
    | 'assert-shape-complete-violated'
    | 'loop-until-convergence'
    | 'loop-until-exhausted'
    | 'negative-no-peer';

export type RallarBlackBoxCompositeConformanceProviderId =
    | 'in-memory-local'
    | 'browser-rallar'
    | 'remote-browser-control';

export type RallarBlackBoxCompositeConformanceCompositeKind = Extract<
    RallarBlackBoxTestCommand['kind'],
    'loop' | 'parallel'
>;

export interface RallarBlackBoxCompositeConformanceHttpService {
    readonly name: string;
    readonly env: string;
    readonly default: string;
}

export interface RallarBlackBoxCompositeConformanceRequirement {
    readonly env: readonly string[];
    readonly httpServices: readonly RallarBlackBoxCompositeConformanceHttpService[];
    readonly playwright: boolean;
    readonly controlServer: boolean;
}

export interface RallarBlackBoxCompositeConformanceCase {
    readonly caseId: RallarBlackBoxCompositeConformanceCaseId;
    readonly title: string;
    readonly intent: string;
    readonly expectedStatus: RallarBlackBoxTestResultStatus;
    readonly requiredCommandKinds: readonly RallarBlackBoxTestCommand['kind'][];
    readonly requiredCompositeKinds: readonly RallarBlackBoxCompositeConformanceCompositeKind[];
    readonly requiredEventTopics: readonly string[];
    readonly expectedFailureCodes: readonly string[];
    readonly liveSafe: boolean;
}

export interface RallarBlackBoxCompositeConformanceProviderIdentity {
    readonly providerId: RallarBlackBoxCompositeConformanceProviderId;
    readonly title: string;
    readonly runtimeSurface: 'local-runtime' | 'browser-adapter' | 'control-server';
    readonly supportedCaseIds: readonly RallarBlackBoxCompositeConformanceCaseId[];
    readonly capabilityDifferences: readonly string[];
}

export interface RallarBlackBoxCompositeConformanceDeterministicProvider
    extends RallarBlackBoxCompositeConformanceProviderIdentity {
    readonly mode: 'deterministic';
}

export interface RallarBlackBoxCompositeConformanceLiveGatedProvider
    extends RallarBlackBoxCompositeConformanceProviderIdentity {
    readonly mode: 'live-gated';
    readonly requires: RallarBlackBoxCompositeConformanceRequirement;
}

export type RallarBlackBoxCompositeConformanceProvider =
    | RallarBlackBoxCompositeConformanceDeterministicProvider
    | RallarBlackBoxCompositeConformanceLiveGatedProvider;

export interface RallarBlackBoxCompositeConformanceRecipeSettings {
    readonly recipeIdPrefix: string;
    readonly runId: string;
    readonly agentId: string;
    readonly environment: string;
    readonly apiBaseUrl: string;
    readonly actor: string;
    readonly sessionId: string;
    readonly roomId: string;
    readonly connection: string;
    readonly wsConnection: string;
    /** Absent when each case sends on its own transport: messages.rtc for parallel groups, realtime otherwise. */
    readonly transport?: Extract<RallarBlackBoxTestTransport, 'realtime' | 'messages.rtc'>;
    readonly timeoutMs: number;
    readonly applicationId: string;
    readonly workspaceId: string;
}

export interface RallarBlackBoxCompositeConformanceRecipeOptions
    extends RallarBlackBoxCompositeConformanceRecipeSettings {
    readonly providerMode: 'simulated' | 'browser-rallar' | 'rallar-remote-browser';
}

export interface CreateRallarBlackBoxCompositeConformanceMatrixInput {
    readonly caseIds: readonly RallarBlackBoxCompositeConformanceCaseId[];
    readonly providerIds: readonly RallarBlackBoxCompositeConformanceProviderId[];
    readonly recipeSettings: RallarBlackBoxCompositeConformanceRecipeSettings;
}

export interface RallarBlackBoxCompositeConformanceMatrixEntryIdentity {
    readonly entryId: string;
    readonly artifactName: string;
    readonly caseId: RallarBlackBoxCompositeConformanceCaseId;
    readonly providerId: RallarBlackBoxCompositeConformanceProviderId;
    readonly case: RallarBlackBoxCompositeConformanceCase;
    readonly provider: RallarBlackBoxCompositeConformanceProvider;
    readonly recipe: RallarBlackBoxTestRecipe;
}

export interface RallarBlackBoxCompositeConformanceSupportedEntry
    extends RallarBlackBoxCompositeConformanceMatrixEntryIdentity {
    readonly supported: true;
}

export interface RallarBlackBoxCompositeConformanceUnsupportedEntry
    extends RallarBlackBoxCompositeConformanceMatrixEntryIdentity {
    readonly supported: false;
    readonly skipReason: string;
}

export type RallarBlackBoxCompositeConformanceMatrixEntry =
    | RallarBlackBoxCompositeConformanceSupportedEntry
    | RallarBlackBoxCompositeConformanceUnsupportedEntry;

export type RallarBlackBoxCompositeConformanceOutcome =
    | Readonly<{ kind: 'skipped'; skipReason: string; }>
    | Readonly<{
        kind: 'ran';
        result: RallarBlackBoxTestResult;
        state: RallarBlackBoxTestState;
        redaction: RallarBlackBoxTestRedactionOptions;
    }>;

export interface RallarBlackBoxCompositeConformanceExpectation {
    readonly resultStatus: RallarBlackBoxTestResultStatus;
    readonly requiredCommandKinds: readonly RallarBlackBoxTestCommand['kind'][];
    readonly requiredCompositeKinds: readonly RallarBlackBoxCompositeConformanceCompositeKind[];
    readonly requiredEventTopics: readonly string[];
    readonly expectedFailureCodes: readonly string[];
}

export interface RallarBlackBoxCompositeConformanceObservation {
    readonly resultStatus: RallarBlackBoxTestResultStatus;
    readonly ok: boolean;
    readonly commandIds: readonly string[];
    readonly commandKinds: readonly RallarBlackBoxTestCommand['kind'][];
    readonly eventTopics: readonly string[];
    readonly diagnostics: number;
    readonly failures: number;
    /** Absent when the command history holds no loop or parallel result. */
    readonly compositeSummary?: RallarBlackBoxCompositeResultSummary;
    readonly failureCodes: readonly string[];
}

export type RallarBlackBoxCompositeConformanceDiagnostic = Pick<
    RallarBlackBoxTestEvent,
    'topic' | 'commandId' | 'severity' | 'payload'
>;

export interface RallarBlackBoxCompositeConformanceReportIdentity {
    readonly schemaVersion: 1;
    readonly entryId: string;
    readonly artifactName: string;
    readonly caseId: RallarBlackBoxCompositeConformanceCaseId;
    readonly providerId: RallarBlackBoxCompositeConformanceProviderId;
}

export interface RallarBlackBoxCompositeConformanceSkippedReport
    extends RallarBlackBoxCompositeConformanceReportIdentity {
    readonly status: 'skipped';
    readonly skipReason: string;
    readonly expected: RallarBlackBoxCompositeConformanceExpectation;
    readonly capabilityDifferences: readonly string[];
}

export interface RallarBlackBoxCompositeConformanceRunReport extends RallarBlackBoxCompositeConformanceReportIdentity {
    readonly status: 'passed' | 'failed';
    readonly expected: RallarBlackBoxCompositeConformanceExpectation;
    readonly observed: RallarBlackBoxCompositeConformanceObservation;
    readonly capabilityDifferences: readonly string[];
    readonly diagnostics: readonly RallarBlackBoxCompositeConformanceDiagnostic[];
    readonly redactedFailures: readonly RallarBlackBoxTestResult[];
}

export type RallarBlackBoxCompositeConformanceReport =
    | RallarBlackBoxCompositeConformanceSkippedReport
    | RallarBlackBoxCompositeConformanceRunReport;

export const RALLAR_BLACK_BOX_COMPOSITE_CONFORMANCE_DEFAULT_RECIPE_SETTINGS:
    RallarBlackBoxCompositeConformanceRecipeSettings = {
        recipeIdPrefix: 'composite-conformance',
        runId: 'rallar-composite-conformance-run',
        agentId: 'local-conformance-agent',
        environment: 'local',
        apiBaseUrl: 'http://localhost:8080',
        actor: 'alice',
        sessionId: 'alice-session',
        roomId: 'rallar-conformance-room',
        connection: 'conformanceRtc',
        wsConnection: 'conformanceWs',
        timeoutMs: 5_000,
        applicationId: 'rallar-server',
        workspaceId: 'default'
    };

export const RALLAR_BLACK_BOX_COMPOSITE_CONFORMANCE_CASES: readonly RallarBlackBoxCompositeConformanceCase[] = [
    {
        caseId: 'looped-rtc-send',
        title: 'Looped RTC Send',
        intent: 'Prove loop cadence, send summaries, stats, and cleanup for repeated RTC traffic.',
        expectedStatus: 'ok',
        requiredCommandKinds: ['configure', 'rtc.connect', 'loop', 'rtc.send', 'stats', 'close'],
        requiredCompositeKinds: ['loop'],
        requiredEventTopics: ['rallar.bb.rtc.connected', 'rallar.conformance.message'],
        expectedFailureCodes: [],
        liveSafe: true
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
            'close'
        ],
        requiredCompositeKinds: ['parallel'],
        requiredEventTopics: ['rallar.bb.ws.message', 'rallar.conformance.message'],
        expectedFailureCodes: [],
        liveSafe: true
    },
    {
        caseId: 'wait-assert-evidence',
        title: 'Wait And Assert Evidence',
        intent: 'Prove send, wait, and assert commands use the same runtime evidence contract.',
        expectedStatus: 'ok',
        requiredCommandKinds: ['configure', 'rtc.connect', 'rtc.send', 'wait', 'assert', 'stats', 'close'],
        requiredCompositeKinds: [],
        requiredEventTopics: ['rallar.conformance.message'],
        expectedFailureCodes: [],
        liveSafe: true
    },
    {
        caseId: 'cancel-during-loop',
        title: 'Cancellation During Loop',
        intent: 'Prove cancellation propagates through a looped recipe and yields partial evidence.',
        expectedStatus: 'cancelled',
        requiredCommandKinds: ['configure', 'loop', 'health', 'recipe.cancel'],
        requiredCompositeKinds: ['loop'],
        requiredEventTopics: [],
        expectedFailureCodes: [],
        liveSafe: true
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
            'close'
        ],
        requiredCompositeKinds: [],
        requiredEventTopics: ['rallar.conformance.message'],
        expectedFailureCodes: [],
        liveSafe: true
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
        liveSafe: true
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
        liveSafe: true
    },
    {
        caseId: 'loop-until-convergence',
        title: 'Loop Until Convergence',
        intent: 'Prove until mode polls an http.request/assert pair to first success.',
        expectedStatus: 'ok',
        requiredCommandKinds: ['configure', 'loop', 'http.request', 'assert', 'stats'],
        requiredCompositeKinds: ['loop'],
        requiredEventTopics: [],
        expectedFailureCodes: [],
        liveSafe: true
    },
    {
        caseId: 'loop-until-exhausted',
        title: 'Loop Until Exhausted Control',
        intent: 'Prove a never-converging until loop exhausts bounds with the last attempt.',
        expectedStatus: 'failed',
        requiredCommandKinds: ['configure', 'loop', 'assert'],
        requiredCompositeKinds: ['loop'],
        requiredEventTopics: [],
        expectedFailureCodes: ['RALLAR_BLACK_BOX_LOOP_UNTIL_EXHAUSTED'],
        liveSafe: true
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
        liveSafe: true
    }
];

export const RALLAR_BLACK_BOX_COMPOSITE_CONFORMANCE_PROVIDERS: readonly RallarBlackBoxCompositeConformanceProvider[] = [
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
            'loop-until-convergence',
            'loop-until-exhausted',
            'negative-no-peer'
        ],
        capabilityDifferences: [
            'Uses deterministic fake transport evidence; no browser WebRTC stack is opened.'
        ]
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
            'loop-until-convergence',
            'loop-until-exhausted',
            'negative-no-peer'
        ],
        requires: {
            env: [
                'RALLAR_API_BASE_URL',
                'RALLAR_ALICE_USERNAME',
                'RALLAR_ALICE_PASSWORD',
                'RALLAR_BOB_USERNAME',
                'RALLAR_BOB_PASSWORD'
            ],
            httpServices: [
                {
                    name: 'Rallar API',
                    env: 'RALLAR_API_BASE_URL',
                    default: 'http://localhost:8080'
                }
            ],
            playwright: true,
            controlServer: false
        },
        capabilityDifferences: [
            'Uses browser adapter diagnostics and real browser transport readiness.',
            'Timing thresholds should stay broad because browser scheduling is host-dependent.'
        ]
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
            'loop-until-convergence',
            'loop-until-exhausted',
            'negative-no-peer'
        ],
        requires: {
            env: [
                'RALLAR_API_BASE_URL',
                'RALLAR_ALICE_USERNAME',
                'RALLAR_ALICE_PASSWORD',
                'RALLAR_BOB_USERNAME',
                'RALLAR_BOB_PASSWORD',
                'RALLAR_BLACK_BOX_CONTROL_BASE_URL',
                'RALLAR_BLACK_BOX_AGENT_ID'
            ],
            httpServices: [
                {
                    name: 'Rallar API',
                    env: 'RALLAR_API_BASE_URL',
                    default: 'http://localhost:8080'
                },
                {
                    name: 'Rallar black-box control server',
                    env: 'RALLAR_BLACK_BOX_CONTROL_BASE_URL',
                    default: 'http://localhost:5180'
                }
            ],
            playwright: false,
            controlServer: true
        },
        capabilityDifferences: [
            'Adds control-server queueing and polling latency to command timing.',
            'Artifacts should retain control-run IDs and agent IDs for join-key lookup.'
        ]
    }
];

/** Entries follow the order of the requested provider and case ids. */
export function createRallarBlackBoxCompositeConformanceMatrix(
    input: CreateRallarBlackBoxCompositeConformanceMatrixInput
): readonly RallarBlackBoxCompositeConformanceMatrixEntry[] {
    const cases = input.caseIds.flatMap((caseId) =>
        RALLAR_BLACK_BOX_COMPOSITE_CONFORMANCE_CASES.filter((entry) => entry.caseId === caseId)
    );
    const providers = input.providerIds.flatMap((providerId) =>
        RALLAR_BLACK_BOX_COMPOSITE_CONFORMANCE_PROVIDERS.filter((entry) => entry.providerId === providerId)
    );
    return providers.flatMap((provider) =>
        cases.map((testCase) => toMatrixEntry(provider, testCase, input.recipeSettings))
    );
}

/** A skipped outcome or an unsupported entry reports skipped; otherwise the observation decides pass or fail. */
export function toRallarBlackBoxCompositeConformanceReport(
    entry: RallarBlackBoxCompositeConformanceMatrixEntry,
    outcome: RallarBlackBoxCompositeConformanceOutcome
): RallarBlackBoxCompositeConformanceReport {
    if (outcome.kind === 'skipped') {
        return toSkippedReport(entry, outcome.skipReason);
    }
    if (!entry.supported) {
        return toSkippedReport(entry, entry.skipReason);
    }

    const { state, redaction } = outcome;
    const diagnostics = state.events.filter((event) => event.kind === 'diagnostic');
    const observed = toObservation(outcome, diagnostics.length);
    return {
        schemaVersion: 1,
        entryId: entry.entryId,
        artifactName: entry.artifactName,
        caseId: entry.caseId,
        providerId: entry.providerId,
        status: isCaseSatisfied(entry.case, observed) ? 'passed' : 'failed',
        expected: toExpectation(entry.case),
        observed,
        capabilityDifferences: entry.provider.capabilityDifferences,
        diagnostics: diagnostics.map((event) => toRedactedDiagnostic(event, redaction)),
        redactedFailures: state.failures.map((failure) => redactRallarBlackBoxValue(failure, redaction))
    };
}

function toMatrixEntry(
    provider: RallarBlackBoxCompositeConformanceProvider,
    testCase: RallarBlackBoxCompositeConformanceCase,
    recipeSettings: RallarBlackBoxCompositeConformanceRecipeSettings
): RallarBlackBoxCompositeConformanceMatrixEntry {
    const entryId = `${provider.providerId}:${testCase.caseId}`;
    const identity: RallarBlackBoxCompositeConformanceMatrixEntryIdentity = {
        entryId,
        artifactName: entryId.replace(/:/g, '-'),
        caseId: testCase.caseId,
        providerId: provider.providerId,
        case: testCase,
        provider,
        recipe: createRallarBlackBoxCompositeConformanceRecipe(testCase.caseId, {
            ...recipeSettings,
            providerMode: toRecipeProviderMode(provider.providerId)
        })
    };
    return provider.supportedCaseIds.includes(testCase.caseId)
        ? { ...identity, supported: true }
        : { ...identity, supported: false, skipReason: `${provider.providerId} does not support ${testCase.caseId}.` };
}

function toRecipeProviderMode(
    providerId: RallarBlackBoxCompositeConformanceProviderId
): RallarBlackBoxCompositeConformanceRecipeOptions['providerMode'] {
    switch (providerId) {
        case 'browser-rallar':
            return 'browser-rallar';
        case 'remote-browser-control':
            return 'rallar-remote-browser';
        case 'in-memory-local':
            return 'simulated';
    }
}

function toSkippedReport(
    entry: RallarBlackBoxCompositeConformanceMatrixEntry,
    skipReason: string
): RallarBlackBoxCompositeConformanceSkippedReport {
    return {
        schemaVersion: 1,
        entryId: entry.entryId,
        artifactName: entry.artifactName,
        caseId: entry.caseId,
        providerId: entry.providerId,
        status: 'skipped',
        skipReason,
        expected: toExpectation(entry.case),
        capabilityDifferences: entry.provider.capabilityDifferences
    };
}

function toObservation(
    outcome: Extract<RallarBlackBoxCompositeConformanceOutcome, Readonly<{ kind: 'ran'; }>>,
    diagnosticCount: number
): RallarBlackBoxCompositeConformanceObservation {
    const { result, state } = outcome;
    const compositeResults = state.commandHistory.filter((entry) => entry.kind === 'loop' || entry.kind === 'parallel');
    return {
        resultStatus: result.status,
        ok: result.ok,
        commandIds: state.commandHistory.map((commandResult) => commandResult.commandId),
        commandKinds: state.commandHistory.map((commandResult) => commandResult.kind),
        eventTopics: state.events.map((event) => event.topic),
        diagnostics: diagnosticCount,
        failures: state.failures.length,
        compositeSummary: compositeResults.length > 0
            ? computeRallarBlackBoxCompositeResultSummary(compositeResults, outcome.redaction)
            : undefined,
        failureCodes: toFailureCodes(result, state.failures)
    };
}

function isCaseSatisfied(
    testCase: RallarBlackBoxCompositeConformanceCase,
    observed: RallarBlackBoxCompositeConformanceObservation
): boolean {
    return observed.resultStatus === testCase.expectedStatus &&
        hasAllValues(observed.commandKinds, testCase.requiredCommandKinds) &&
        hasAllValues(observed.commandKinds, testCase.requiredCompositeKinds) &&
        hasAllValues(observed.eventTopics, testCase.requiredEventTopics) &&
        hasAllValues(observed.failureCodes, testCase.expectedFailureCodes);
}

function toExpectation(
    testCase: RallarBlackBoxCompositeConformanceCase
): RallarBlackBoxCompositeConformanceExpectation {
    return {
        resultStatus: testCase.expectedStatus,
        requiredCommandKinds: testCase.requiredCommandKinds,
        requiredCompositeKinds: testCase.requiredCompositeKinds,
        requiredEventTopics: testCase.requiredEventTopics,
        expectedFailureCodes: testCase.expectedFailureCodes
    };
}

function hasAllValues<T>(actual: readonly T[], expected: readonly T[]): boolean {
    return expected.every((value) => actual.includes(value));
}

function toFailureCodes(
    result: RallarBlackBoxTestResult,
    failures: readonly RallarBlackBoxTestResult[]
): readonly string[] {
    const codes = [result.error, ...failures.map((failure) => failure.error)].flatMap(decodeErrorCodes);
    return [...new Set(codes)].sort();
}

/** Codes nested anywhere in an error, including its details, count as failure codes. */
function decodeErrorCodes(value: unknown): readonly string[] {
    if (Array.isArray(value)) {
        return value.flatMap(decodeErrorCodes);
    }
    if (!isJsonRecordValue(value)) {
        return [];
    }
    return [
        ...(typeof value.code === 'string' ? [value.code] : []),
        ...Object.values(value).flatMap(decodeErrorCodes)
    ];
}

function toRedactedDiagnostic(
    event: RallarBlackBoxTestEvent,
    redaction: RallarBlackBoxTestRedactionOptions
): RallarBlackBoxCompositeConformanceDiagnostic {
    return redactRallarBlackBoxValue({
        topic: event.topic,
        commandId: event.commandId,
        severity: event.severity,
        payload: event.payload
    }, redaction);
}
