// deno-lint-ignore-file no-explicit-any
import { compareJson, COMPARISON, toConfig } from '../json-compare/CompareJson.ts';
import {
    rememberRtcCloseEvent,
    type RtcClient,
    type RtcProvider,
    toRtcPayload,
    toRtcFailureStatus, toRtcSuccessStatus,
} from './rtc-provider.ts';
import {
    toWsConnectionName,
    toWsExpectedConnectionName,
    toWsFailureStatus,
    toWsSuccessStatus,
    waitForWsClose,
    waitForWsMessage,
    waitForWsMessageAbsence,
    waitForWsMessages,
} from './ws/ws-wait-expectations.ts';
import { createRallarStubRtcProvider } from './rallar-stub-rtc-provider.ts';
import { createRallarWebRtcWebSocketSignalingProvider } from './rallar-webrtc-runtime.ts';
import {createRallarInMemoryProvider} from './rallar-in-memory-runtime.ts';
import { createRallarBrowserRtcProvider } from './rallar-browser-rtc-provider.ts';
import {
    createRallarRemoteBrowserRtcProvider,
    executeRallarRemoteBrowserCommand,
    resolveRallarRemoteBrowserConfig,
    syncRallarRemoteBrowserEvents,
    toRallarRemoteBrowserCommandId,
    type RallarRemoteBrowserConfig,
    type RallarRemoteBrowserControlFetch,
    type RallarRemoteBrowserControlResultEnvelope,
} from './rallar-remote-browser-provider.ts';
import type { RallarBlackBoxTestCommand } from '../rallar-bb-test/types.ts';
import { normalizeBlackBoxResponseHeaders } from './http/normalize-black-box-response-headers.ts';
import { executeHttpInteraction } from './http/execute-http-interaction.ts';
import { validateAssertValueComparators } from './expectations/assert-value-comparators.ts';
import {
    toHttpInteractionStatus,
    toStatus,
} from './http/http-response-expectations.ts';
import {
    directSafeOutputTransformSpec,
    evaluateSafeOutputTransform,
    isSafeOutputTransformOnlySpec,
    SafeOutputTransformError,
} from './scenario-transform/safe-output-transform.ts';
const SUCCESS = 'SUCCESS';
const FAILURE = 'FAILURE';
declare const process: { env: Record<string, string | undefined> } | undefined;
type Redaction = {
    name: string
    value: string
}

type RunnerCorrelationConfig = {
    runnerRunId: string
    enabled: boolean
    injectHeaders: boolean
    injectPayloads: boolean
    runIdHeader: string
    stepIdHeader: string
    payloadField: string
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function defaultEnvironment(): Record<string, string | undefined> {
    return typeof process !== 'undefined'
        ? process.env
        : {};
}

function isEnvVariableDescriptor(value: unknown): value is Record<string, unknown> {
    return isRecord(value) &&
        (typeof value.env === 'string' || typeof value.fromEnv === 'string');
}

function toSecretNameSet(secretVariables: unknown): Set<string> {
    if (Array.isArray(secretVariables)) {
        return new Set(secretVariables.map(String));
    }

    if (typeof secretVariables === 'string') {
        return new Set(
            secretVariables
                .split(',')
                .map(value => value.trim())
                .filter(value => value.length > 0),
        );
    }

    return new Set();
}

function addRedaction(redactions: Redaction[], name: string, value: unknown): void {
    if (value === undefined || value === null) {
        return;
    }

    const text = String(value);
    if (text.length <= 0) {
        return;
    }

    if (redactions.some(redaction => redaction.name === name && redaction.value === text)) {
        return;
    }

    redactions.push({
        name,
        value: text,
    });
}

function normalizeRedactions(redactions: unknown): Redaction[] {
    if (Array.isArray(redactions)) {
        return redactions.flatMap(redaction => {
            if (isRecord(redaction) && typeof redaction.value === 'string' && redaction.value.length > 0) {
                return [{
                    name: typeof redaction.name === 'string' && redaction.name.length > 0
                        ? redaction.name
                        : 'secret',
                    value: redaction.value,
                }];
            }

            return [];
        });
    }

    if (isRecord(redactions)) {
        return Object.entries(redactions).flatMap(([name, value]) => {
            if (value === undefined || value === null || String(value).length <= 0) {
                return [];
            }

            return [{
                name,
                value: String(value),
            }];
        });
    }

    return [];
}

function randomUuid(): string {
    const cryptoApi = globalThis.crypto as Crypto | undefined;
    if (cryptoApi?.randomUUID) {
        return cryptoApi.randomUUID();
    }

    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, character => {
        const random = Math.floor(Math.random() * 16);
        const value = character === 'x' ? random : (random & 0x3) | 0x8;
        return value.toString(16);
    });
}

function stringOption(...values: unknown[]): string | undefined {
    for (const value of values) {
        if (typeof value === 'string' && value.length > 0) {
            return value;
        }
    }

    return undefined;
}

function booleanOption(...values: unknown[]): boolean {
    return values.some(value => value === true);
}

function toRunnerCorrelationConfig(options: any = {}): RunnerCorrelationConfig {
    const rawCorrelation = isRecord(options.correlation)
        ? options.correlation
        : {};
    const enabled = options.correlation !== false && rawCorrelation.enabled !== false;

    return {
        runnerRunId: stringOption(
            rawCorrelation.runnerRunId,
            rawCorrelation.runId,
            options.runnerRunId,
            options.runId,
        ) || 'bb-run-' + randomUuid(),
        enabled,
        injectHeaders: enabled && booleanOption(
            rawCorrelation.injectHeaders,
            rawCorrelation.headerInjection,
            rawCorrelation.headers,
        ),
        injectPayloads: enabled && booleanOption(
            rawCorrelation.injectPayloads,
            rawCorrelation.injectPayload,
            rawCorrelation.payloadInjection,
            rawCorrelation.payloads,
        ),
        runIdHeader: stringOption(
            rawCorrelation.runIdHeader,
            rawCorrelation.runnerRunIdHeader,
            rawCorrelation.headers && isRecord(rawCorrelation.headers) ? rawCorrelation.headers.runId : undefined,
            rawCorrelation.headers && isRecord(rawCorrelation.headers) ? rawCorrelation.headers.runnerRunId : undefined,
        ) || 'x-rallar-black-box-run-id',
        stepIdHeader: stringOption(
            rawCorrelation.stepIdHeader,
            rawCorrelation.runnerStepIdHeader,
            rawCorrelation.headers && isRecord(rawCorrelation.headers) ? rawCorrelation.headers.stepId : undefined,
            rawCorrelation.headers && isRecord(rawCorrelation.headers) ? rawCorrelation.headers.runnerStepId : undefined,
        ) || 'x-rallar-black-box-step-id',
        payloadField: stringOption(
            rawCorrelation.payloadField,
            rawCorrelation.payloadKey,
            rawCorrelation.field,
        ) || 'blackBoxRunner',
    };
}

function toPublicCorrelationConfig(config: RunnerCorrelationConfig): any {
    return {
        runnerRunId: config.runnerRunId,
        enabled: config.enabled,
        injection: {
            headers: config.injectHeaders,
            payloads: config.injectPayloads,
            runIdHeader: config.runIdHeader,
            stepIdHeader: config.stepIdHeader,
            payloadField: config.payloadField,
        },
    };
}

export function resolveBlackBoxVariables(
    rawVariables: Record<string, unknown> = {},
    environment: Record<string, string | undefined> = defaultEnvironment(),
    secretVariables: unknown = [],
): { variables: Record<string, unknown>, redactions: Redaction[] } {
    const secrets = toSecretNameSet(secretVariables);
    const variables: Record<string, unknown> = {};
    const redactions: Redaction[] = [];

    Object.entries(rawVariables || {}).forEach(([key, value]) => {
        if (isEnvVariableDescriptor(value)) {
            const envName = String(value.env ?? value.fromEnv);
            const envValue = environment[envName];
            const hasEnvValue = envValue !== undefined && (envValue.length > 0 || value.allowEmpty === true);
            const fallbackValue = value.default !== undefined
                ? value.default
                : value.fallback;

            if (!hasEnvValue && fallbackValue === undefined && value.required === true) {
                throw new Error(`Missing required environment variable ${envName} for black-box variable ${key}`);
            }

            const resolvedValue = hasEnvValue
                ? envValue
                : fallbackValue;

            variables[key] = resolvedValue;

            if (value.secret === true || value.redact === true || secrets.has(key)) {
                addRedaction(redactions, String(value.redactAs || key), resolvedValue);
            }

            return;
        }

        variables[key] = value;

        if (secrets.has(key)) {
            addRedaction(redactions, key, value);
        }
    });

    return {
        variables,
        redactions,
    };
}

function redactString(value: string, redactions: Redaction[]): string {
    return redactions.reduce((text, redaction) => {
        return redaction.value.length > 0
            ? text.replaceAll(redaction.value, `<redacted:${redaction.name}>`)
            : text;
    }, value);
}

export function redactBlackBoxData<T>(value: T, redactions: Redaction[] = []): T {
    if (redactions.length <= 0) {
        return value;
    }

    if (typeof value === 'string') {
        return redactString(value, redactions) as T;
    }

    if (Array.isArray(value)) {
        return value.map(item => redactBlackBoxData(item, redactions)) as T;
    }

    if (isRecord(value)) {
        return Object.fromEntries(
            Object.entries(value)
                .map(([key, nested]) => [key, redactBlackBoxData(nested, redactions)]),
        ) as T;
    }

    return value;
}

function createMissingRtcProvider(providerName: string): RtcProvider {
    const missing = (interaction: any, config: any, context: any): Promise<any> => {
        return Promise.resolve(toRtcFailureStatus(
            config,
            interaction,
            'RTC provider is not configured: ' + providerName,
            {
                availableProviders: Object.keys(context.rtcProviders || {}),
            },
        ));
    };

    return {
        connect: missing,
        send: missing,
        wait: missing,
        close: missing,
    };
}

function createRtcProviders(): Record<string, RtcProvider> {
    const signalingProvider = createRallarWebRtcWebSocketSignalingProvider();
    return {
        // Legacy alias; prefer `rallar-signaling` in new signaling-only recipes.
        rallar: signalingProvider,
        'rallar-signaling': signalingProvider,
        'rallar-stub': createRallarStubRtcProvider(),
        'rallar-memory': createRallarInMemoryProvider(),
        'rallar-browser': createRallarBrowserRtcProvider(),
        'rallar-remote-browser': createRallarRemoteBrowserRtcProvider(),
    };
}

function createScenarioContext(options: any = {}): any {
    const resolvedVariables = resolveBlackBoxVariables(
        options.variables || {},
        options.environment || defaultEnvironment(),
        options.secretVariables || options.secrets || [],
    );
    const correlation = toRunnerCorrelationConfig(options);

    return {
        variables: resolvedVariables.variables,
        outputs: {},
        results: {},
        resultsList: [],
        resultsByName: {},
        wsConnections: {},
        wsMessages: {},
        wsCloseEvents: {},
        rtcConnections: {},
        rtcMessages: {},
        rtcDiagnostics: {},
        rtcCloseEvents: {},
        rtcProviders: {
            ...createRtcProviders(),
            ...options.rtcProviders,
        },
        options,
        dryRun: options?.dryRun === true,
        correlation,
        redactions: [
            ...resolvedVariables.redactions,
            ...normalizeRedactions(options.redactions),
        ],
    };
}

function toResolverRoot(context: any): any {
    return {
        ...context.variables,
        ...context.outputs,
        variables: context.variables,
        outputs: context.outputs,
        results: context.results,
        resultsList: context.resultsList,
        resultsByName: context.resultsByName,
        runnerRunId: context.correlation?.runnerRunId,
        correlation: toPublicCorrelationConfig(context.correlation),
    };
}

function resolvePath(path: string, root: any): any {
    const resolved = path.split('.')
        .reduce((prev, curr) => prev === undefined || prev === null ? undefined : prev[curr], root);

    if (resolved === undefined) {
        throw new Error('Cannot resolve placeholder {' + path + '}');
    }

    return resolved;
}

function pathSegments(path: string): string[] {
    return path
        .replaceAll(/\[(\d+)]/g, '.$1')
        .split('.')
        .map(segment => segment.trim())
        .filter(segment => segment.length > 0);
}

function tryResolvePath(path: string, root: any): { found: boolean, value?: any } {
    const segments = pathSegments(path);
    let value = root;

    for (const segment of segments) {
        if (value === undefined || value === null) {
            return {
                found: false,
            };
        }

        value = value[segment];
    }

    return value === undefined
        ? {
            found: false,
        }
        : {
            found: true,
            value,
        };
}

function extractOutputPath(result: any, outputPath: unknown): any {
    if (outputPath === undefined || outputPath === null || outputPath === '') {
        return result.actual;
    }

    if (typeof outputPath !== 'string') {
        throw new Error('Output path must be a string');
    }

    const roots = [
        result,
        result?.actual,
        result?.actual?.body,
    ];

    for (const root of roots) {
        const resolved = tryResolvePath(outputPath, root);
        if (resolved.found) {
            return resolved.value;
        }
    }

    throw new Error('Cannot resolve output path {' + outputPath + '}');
}

type OutputExtraction = {
    name: string
    path?: unknown
    transform?: unknown
    secret?: boolean
    redactAs?: string
}

interface EvaluateScenarioTransformInput {
    readonly transform: unknown
    readonly context: any
    readonly result?: any
    readonly operatorPath?: string
}

function evaluateScenarioTransform(input: EvaluateScenarioTransformInput): any {
    return evaluateSafeOutputTransform(input.transform, {
        resolverRoot: toResolverRoot(input.context),
        result: input.result,
        operatorPath: input.operatorPath,
        createUuid: randomUuid,
        readTimestamp: Date.now,
    });
}

function outputExtractions(result: any): OutputExtraction[] {
    const extractions: OutputExtraction[] = [];

    if (typeof result.output === 'string' && result.output.length > 0) {
        extractions.push({
            name: result.output,
            path: result.outputPath,
            transform: result.transform,
            secret: result.secret === true || result.redact === true,
            redactAs: typeof result.redactAs === 'string' ? result.redactAs : undefined,
        });
    }

    if (isRecord(result.outputs)) {
        Object.entries(result.outputs).forEach(([name, spec]) => {
            if (typeof spec === 'string') {
                extractions.push({
                    name,
                    path: spec,
                });
                return;
            }

            if (isRecord(spec)) {
                extractions.push({
                    name,
                    path: spec.path ?? spec.from ?? spec.outputPath,
                    transform: spec.transform ?? directSafeOutputTransformSpec(spec),
                    secret: spec.secret === true || spec.redact === true,
                    redactAs: typeof spec.redactAs === 'string' ? spec.redactAs : undefined,
                });
                return;
            }

            extractions.push({
                name,
                path: spec,
            });
        });
    }

    return extractions;
}

function withExtractedOutputs(result: any, context: any): any {
    if (result?.status !== SUCCESS) {
        return result;
    }

    const extractions = outputExtractions(result);
    if (extractions.length <= 0) {
        return result;
    }

    const extractionErrors: any[] = [];
    const extractedOutputs: Array<OutputExtraction & { value: any }> = [];

    extractions.forEach(extraction => {
        try {
            const value = extraction.transform !== undefined
                ? evaluateScenarioTransform({
                    transform: extraction.transform,
                    context,
                    result,
                    operatorPath: `outputs.${extraction.name}`,
                })
                : extractOutputPath(result, extraction.path);
            extractedOutputs.push({
                ...extraction,
                value,
            });
        } catch (error) {
            extractionErrors.push({
                output: extraction.name,
                path: extraction.path,
                transform: extraction.transform,
                error: error instanceof Error ? error.message : String(error),
                details: error instanceof SafeOutputTransformError ? error.details : undefined,
            });
        }
    });

    if (extractionErrors.length <= 0) {
        extractedOutputs.forEach(extraction => {
            context.outputs[extraction.name] = extraction.value;
            if (extraction.secret) {
                addRedaction(context.redactions, extraction.redactAs || extraction.name, extraction.value);
            }
        });

        return result;
    }

    return {
        ...result,
        status: FAILURE,
        result: 'Output extraction failed',
        details: {
            ...(isRecord(result.details) ? result.details : {}),
            outputExtractionErrors: extractionErrors,
        },
    };
}

function stringifyResolvedValue(value: any): string {
    if (value === undefined || value === null) {
        return String(value);
    }

    return typeof value === 'string'
        ? value
        : JSON.stringify(value);
}

function resolveStringPlaceholders(value: string, context: any): any {
    const exactPlaceholderMatch = value.match(/^\{([A-Za-z_$][\w$-]*(?:\.[\w$-]+)*)\}$/u);

    if (exactPlaceholderMatch) {
        return resolvePath(exactPlaceholderMatch[1], toResolverRoot(context));
    }

    return value.replaceAll(/\{([A-Za-z_$][\w$-]*(?:\.[\w$-]+)*)\}/gu, (_match, path) => {
        return stringifyResolvedValue(resolvePath(path, toResolverRoot(context)));
    });
}

function resolvePlaceholders(value: any, context: any): any {
    if (typeof value === 'string') {
        return resolveStringPlaceholders(value, context);
    }

    if (Array.isArray(value)) {
        return value.map(item => resolvePlaceholders(item, context));
    }

    if (value && typeof value === 'object') {
        if (isSafeOutputTransformOnlySpec(value as Record<string, unknown>)) {
            return value;
        }

        return Object.fromEntries(
            Object.entries(value)
                .map(([key, nested]) => [key, resolvePlaceholders(nested, context)])
        );
    }

    return value;
}

function resolveAssertActual(value: any, context: any, missingActualValue: any): any {
    if (typeof value === 'string') {
        try {
            return resolveStringPlaceholders(value, context);
        } catch (error) {
            if (missingActualValue !== undefined) {
                return missingActualValue;
            }
            throw error;
        }
    }

    if (Array.isArray(value)) {
        return value.map(item => resolveAssertActual(item, context, missingActualValue));
    }

    if (value && typeof value === 'object') {
        if (isSafeOutputTransformOnlySpec(value as Record<string, unknown>)) {
            return value;
        }

        return Object.fromEntries(
            Object.entries(value)
                .map(([key, nested]) => [key, resolveAssertActual(nested, context, missingActualValue)]),
        );
    }

    return value;
}

function toResultKey(interactionData: any): string {
    return [
        interactionData.name,
        'i' + interactionData.interactionExecutionNumber,
        interactionData.repeatIndex !== undefined ? 'r' + interactionData.repeatIndex : undefined,
    ]
        .filter(value => value !== undefined && value !== null && value !== '')
        .join('-');
}

function storeInteractionData(interactionData: any, context: any): any {
    if (!interactionData || !interactionData.name) {
        return interactionData;
    }

    const resultKey = toResultKey(interactionData);

    const resultWithKey = withExtractedOutputs({
        ...interactionData,
        resultKey,
    }, context);
    const storedResult = resultWithKey?.status === FAILURE &&
            (resultWithKey?.nonBlockingFailure === true ||
                resultWithKey?.interaction?.request?.nonBlockingFailure === true)
        ? {
            ...resultWithKey,
            nonBlockingFailure: true,
        }
        : resultWithKey;

    context.results[resultKey] = storedResult;
    context.resultsList.push(storedResult);

    if (!context.resultsByName[interactionData.name]) {
        context.resultsByName[interactionData.name] = [];
    }

    context.resultsByName[interactionData.name].push(storedResult);

    return storedResult;
}

function sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
}

function toOutputReportFields(interaction: any): any {
    return {
        output: interaction.request.output,
        outputPath: interaction.request.outputPath,
        outputs: interaction.request.outputs,
        transform: interaction.request.transform,
        secret: interaction.request.secret,
        redact: interaction.request.redact,
        redactAs: interaction.request.redactAs,
    };
}

function toInteractionName(interactionWithConfig: any): string {
    return Object.keys(interactionWithConfig)
        .filter(key => !['HTTP', 'MQ', 'WS', 'RTC', 'WEBRTC', 'CRDT', 'ASSERT', 'SET', 'PARALLEL'].includes(key))[0];
}

function toInteractionConfig(interactionWithConfig: any): any {
    const name = toInteractionName(interactionWithConfig);

    return {
        interactionName: name,
        ...interactionWithConfig[name],
    };
}

function toExecutableInteraction(interaction: any): any {
    return interaction?.HTTP
        || interaction?.MQ
        || interaction?.WS
        || interaction?.RTC
        || interaction?.WEBRTC
        || interaction?.CRDT
        || interaction?.ASSERT
        || interaction?.SET
        || interaction?.PARALLEL;
}

function toRunnerStepId(correlation: RunnerCorrelationConfig, request: any, interactionName: string, options: any = {}): string {
    const runIndex = Number.parseInt(String(options.runIndex || request.runIndex || 1), 10) || 1;
    const scenarioExecutionNumber = Number.parseInt(String(request.scenarioExecutionNumber || 1), 10) || 1;
    const interactionExecutionNumber = Number.parseInt(String(request.interactionExecutionNumber || 0), 10) || 0;
    const repeatIndex = Number.parseInt(String(request.repeatIndex || 1), 10) || 1;
    const safeName = String(interactionName || 'step')
        .replace(/[^a-zA-Z0-9_.:-]+/g, '-')
        .replace(/^-+|-+$/g, '') || 'step';

    return [
        correlation.runnerRunId,
        'run',
        runIndex,
        'scenario',
        scenarioExecutionNumber,
        'step',
        interactionExecutionNumber,
        safeName,
        'repeat',
        repeatIndex,
    ].join('-');
}

function toStepCorrelation(interaction: any, config: any, context: any): any {
    const request = interaction.request || {};
    const correlation = context.correlation as RunnerCorrelationConfig;
    const runIndex = Number.parseInt(String(context.options?.runIndex || request.runIndex || 1), 10) || 1;
    const runnerStepId = stringOption(request.runnerStepId, request.correlation?.runnerStepId) ||
        toRunnerStepId(correlation, request, config.interactionName, context.options);

    return {
        runnerRunId: correlation.runnerRunId,
        runnerStepId,
        runIndex,
        scenarioExecutionNumber: request.scenarioExecutionNumber,
        interactionExecutionNumber: request.interactionExecutionNumber,
        repeatIndex: request.repeatIndex,
        interactionName: config.interactionName,
    };
}

function toCorrelationReportFields(interaction: any): any {
    const correlation = interaction?.request?.correlation;
    if (!correlation) {
        return {};
    }

    return {
        runnerRunId: correlation.runnerRunId,
        runnerStepId: correlation.runnerStepId,
        correlation,
    };
}

function isSendAction(request: any): boolean {
    return String(request?.action || 'send').toLowerCase() === 'send';
}

function mergePayloadCorrelation(value: unknown, correlation: any, payloadField: string): unknown {
    if (!isRecord(value)) {
        return value;
    }

    return {
        ...value,
        [payloadField]: {
            ...(isRecord(value[payloadField]) ? value[payloadField] : {}),
            runnerRunId: correlation.runnerRunId,
            runnerStepId: correlation.runnerStepId,
        },
    };
}

function injectCorrelationPayload(request: any, correlation: any, payloadField: string): boolean {
    if (request.send !== undefined) {
        const next = mergePayloadCorrelation(request.send, correlation, payloadField);
        if (next !== request.send) {
            request.send = next;
            return true;
        }
        return false;
    }

    if (request.message !== undefined) {
        const next = mergePayloadCorrelation(request.message, correlation, payloadField);
        if (next !== request.message) {
            request.message = next;
            return true;
        }
        return false;
    }

    if (request.body !== undefined) {
        const next = mergePayloadCorrelation(request.body, correlation, payloadField);
        if (next !== request.body) {
            request.body = next;
            return true;
        }
    }

    return false;
}

function applyInteractionCorrelation(interactionWithConfig: any, interaction: any, config: any, context: any): void {
    const request = interaction.request || {};
    const correlationConfig = context.correlation as RunnerCorrelationConfig;
    const correlation = toStepCorrelation(interaction, config, context);
    const transport = interactionWithConfig.HTTP
        ? 'HTTP'
        : interactionWithConfig.WS
            ? 'WS'
            : interactionWithConfig.CRDT
                ? 'CRDT'
                : interactionWithConfig.RTC || interactionWithConfig.WEBRTC
                    ? 'RTC'
                    : interactionWithConfig.PARALLEL
                        ? 'PARALLEL'
                        : interactionWithConfig.SET
                            ? 'SET'
                            : interactionWithConfig.ASSERT
                                ? 'ASSERT'
                                : 'UNKNOWN';

    request.correlation = {
        ...correlation,
        transport,
        injected: {
            headers: false,
            payload: false,
        },
    };
    request.runnerRunId = correlation.runnerRunId;
    request.runnerStepId = correlation.runnerStepId;

    if (correlationConfig.injectHeaders && interactionWithConfig.HTTP) {
        request.headers = {
            ...(isRecord(request.headers) ? request.headers : {}),
            [correlationConfig.runIdHeader]: correlation.runnerRunId,
            [correlationConfig.stepIdHeader]: correlation.runnerStepId,
        };
        request.correlation.injected.headers = true;
    }

    if (
        correlationConfig.injectPayloads &&
        isSendAction(request) &&
        (interactionWithConfig.WS || interactionWithConfig.RTC || interactionWithConfig.WEBRTC)
    ) {
        request.correlation.injected.payload = injectCorrelationPayload(
            request,
            correlation,
            correlationConfig.payloadField,
        );
    }
}

function toSetSuccessStatus(config: any, interaction: any, value: any): any {
    return {
        name: config.interactionName,
        status: SUCCESS,
        transport: 'SET',
        ...toCorrelationReportFields(interaction),
        scenarioExecutionNumber: config.interaction.request.scenarioExecutionNumber,
        interactionExecutionNumber: config.interaction.request.interactionExecutionNumber,
        repeatIndex: config.interaction.request.repeatIndex,
        delayMs: config.interaction.request.delayMs,
        expected: interaction.response,
        actual: value,
        ...toOutputReportFields(interaction),
        input: interaction.request.input,
    };
}

function toSetFailureStatus(config: any, interaction: any, result: string, details: any = {}): any {
    return {
        name: config.interactionName,
        status: FAILURE,
        transport: 'SET',
        result,
        ...toCorrelationReportFields(interaction),
        scenarioExecutionNumber: config.interaction.request.scenarioExecutionNumber,
        interactionExecutionNumber: config.interaction.request.interactionExecutionNumber,
        repeatIndex: config.interaction.request.repeatIndex,
        expected: interaction.response,
        actual: undefined,
        details,
        ...config,
    };
}

async function executeSetInteraction(interaction: any, config: any, context: any): Promise<any> {
    const output = interaction.request.output;
    const transform = interaction.request.transform ?? interaction.request.derive;
    let value = interaction.request.value !== undefined ? interaction.request.value : interaction.response.actual;
    const evidence = interaction.request.stateWriteEvidence;
    const delayMs = Number.parseInt(String(interaction.request.delayMs ?? 0), 10);

    if (evidence !== undefined) {
        const collector = context.options.stateWriteEvidenceCollector;
        if (typeof collector !== 'function') throw new Error('State-write evidence collector is unavailable.');
        value = await collector(evidence);
    }
    if (!output) {
        return toSetFailureStatus(config, interaction,
            'Set step is missing output. Use output to name the stored value.',
        );
    }

    if (transform !== undefined) {
        try {
            value = evaluateScenarioTransform({
                transform,
                context,
                operatorPath: `set.${String(output)}`,
            });
        } catch (error) {
            return toSetFailureStatus(
                config,
                interaction,
                'Set transform failed.',
                {
                    transform,
                    transformError: {
                        message: error instanceof Error ? error.message : String(error),
                        details: error instanceof SafeOutputTransformError ? error.details : undefined,
                    },
                },
            );
        }
    }

    if (value === undefined) {
        return toSetFailureStatus(
            config,
            interaction,
            'Set step is missing value. Use value, request.value, or transform.',
        );
    }

    if (Number.isFinite(delayMs) && delayMs > 0) await sleep(delayMs);

    return toSetSuccessStatus(config, interaction, value);
}

function toAssertSuccessStatus(config: any, interaction: any, actual: any, details: any = {}): any {
    return {
        name: config.interactionName,
        status: SUCCESS,
        transport: 'ASSERT',
        ...toCorrelationReportFields(interaction),
        scenarioExecutionNumber: config.interaction.request.scenarioExecutionNumber,
        interactionExecutionNumber: config.interaction.request.interactionExecutionNumber,
        repeatIndex: config.interaction.request.repeatIndex,
        expected: interaction.response,
        actual,
        details,
        ...toOutputReportFields(interaction),
        input: interaction.request.input,
    };
}

function toAssertFailureStatus(config: any, interaction: any, actual: any, result: string, details: any = {}): any {
    return {
        name: config.interactionName,
        status: FAILURE,
        transport: 'ASSERT',
        result,
        ...toCorrelationReportFields(interaction),
        scenarioExecutionNumber: config.interaction.request.scenarioExecutionNumber,
        interactionExecutionNumber: config.interaction.request.interactionExecutionNumber,
        repeatIndex: config.interaction.request.repeatIndex,
        expected: interaction.response,
        actual,
        details,
        ...config,
    };
}

function monotonicComparisonFailures(actual: any, paths: unknown): any[] {
    if (!Array.isArray(paths)) {
        return [];
    }

    return paths.flatMap<any>(path => {
        if (typeof path !== 'string' || path.length <= 0) {
            return [{ path, error: 'Monotonic assertion paths must be non-empty strings.' }];
        }

        let values: unknown;
        try {
            values = resolvePath(path, actual);
        } catch (error) {
            return [{
                path,
                error: error instanceof Error ? error.message : String(error),
            }];
        }

        if (!Array.isArray(values) || values.length <= 0) {
            return [{ path, values, error: 'Monotonic assertion path must resolve to a non-empty array.' }];
        }

        const numericValues = values.map(value => Number(value));
        if (numericValues.some(value => !Number.isFinite(value))) {
            return [{ path, values, error: 'Monotonic assertion values must be finite numbers.' }];
        }

        const regressionIndex = numericValues.findIndex((value, index) =>
            index > 0 && value < numericValues[index - 1]
        );
        return regressionIndex < 0
            ? []
            : [{
                path,
                values,
                regressionIndex,
                previous: numericValues[regressionIndex - 1],
                current: numericValues[regressionIndex],
            }];
    });
}

function toResolvedAssertActual(interaction: any, context: any): any {
    return interaction.response.actual !== undefined
        ? isRecord(interaction.response.actual) && interaction.response.actual.transform !== undefined
            ? evaluateScenarioTransform({
                transform: interaction.response.actual.transform,
                context,
                operatorPath: 'assert.actual',
            })
            : resolveAssertActual(
                interaction.response.actual,
                context,
                interaction.response.missingActualValue,
            )
        : interaction.request.actual;
}

function toAssertAnyOfStatus(interaction: any, config: any, actual: any): any {
    const expectedAlternatives = interaction.response.anyOf;
    const comparisons = expectedAlternatives.map((expectedValue: any) => compareJson(
        expectedValue,
        actual,
        toConfig(
            interaction.response?.comparison || COMPARISON.COMPATIBLE,
            interaction.response?.ignoreJsonKeys || [],
            interaction.response?.ignoreJsonPaths || [],
        ),
    ));
    const matchedIndex = comparisons.findIndex((result: any) => result.isEqual);

    if (matchedIndex < 0) {
        return toAssertFailureStatus(config, interaction, actual, 'Assert comparison failed', {
            anyOf: expectedAlternatives,
            comparisons,
        });
    }

    return toAssertSuccessStatus(config, interaction, actual, {
        anyOfMatchedIndex: matchedIndex,
        comparison: comparisons[matchedIndex],
    });
}

function executeAssertInteraction(interaction: any, config: any, context: any): Promise<any> {
    const expectedAlternatives = Array.isArray(interaction.response.anyOf)
        ? interaction.response.anyOf
        : [];
    const comparators = Array.isArray(interaction.response.comparators)
        ? interaction.response.comparators
        : [];
    const expected = interaction.response.body !== undefined
        ? interaction.response.body
        : interaction.response.expect !== undefined
            ? interaction.response.expect
            : interaction.response.expected;

    const actual = toResolvedAssertActual(interaction, context);

    if (expected === undefined && expectedAlternatives.length <= 0 && comparators.length <= 0) {
        return Promise.resolve(toAssertFailureStatus(
            config,
            interaction,
            actual,
            'Assert step is missing expected value. ' +
                'Use expect.body, expect.expect, expect.expected, or expect.comparators.',
        ));
    }

    if (actual === undefined) {
        return Promise.resolve(toAssertFailureStatus(
            config,
            interaction,
            actual,
            'Assert step is missing actual value. Use actual or expect.actual.',
        ));
    }

    const monotonicFailures = monotonicComparisonFailures(
        actual,
        interaction.response.monotonicPaths,
    );
    if (monotonicFailures.length > 0) {
        return Promise.resolve(toAssertFailureStatus(
            config,
            interaction,
            actual,
            'Assert monotonic comparison failed',
            {
                monotonicPaths: interaction.response.monotonicPaths,
                failures: monotonicFailures,
            },
        ));
    }

    const comparatorIssues = validateAssertValueComparators(actual, comparators);
    if (comparatorIssues.length > 0) {
        return Promise.resolve(toAssertFailureStatus(
            config,
            interaction,
            actual,
            'Assert comparator failed',
            {
                comparators,
                failures: comparatorIssues,
            },
        ));
    }

    if (expectedAlternatives.length > 0) {
        return Promise.resolve(toAssertAnyOfStatus(interaction, config, actual));
    }

    if (expected === undefined) {
        return Promise.resolve(toAssertSuccessStatus(config, interaction, actual, {
            comparators,
        }));
    }

    const comparisonResult = compareJson(
        expected,
        actual,
        toConfig(
            interaction.response?.comparison || COMPARISON.COMPATIBLE,
            interaction.response?.ignoreJsonKeys || [],
            interaction.response?.ignoreJsonPaths || [],
        ),
    );

    if (!comparisonResult.isEqual) {
        return Promise.resolve(toAssertFailureStatus(
            config,
            interaction,
            actual,
            'Assert comparison failed',
            comparisonResult,
        ));
    }

    return Promise.resolve(toAssertSuccessStatus(config, interaction, actual, comparisonResult));
}

function remoteBrowserOptions(context: any): any {
    return context.options?.rallarRemoteBrowser ??
        context.options?.remoteBrowser ??
        {};
}

function remoteBrowserFetch(context: any): RallarRemoteBrowserControlFetch {
    return remoteBrowserOptions(context).fetch ?? fetch;
}

function isRallarRemoteBrowserRequest(request: any): boolean {
    const control = request?.control ?? {};
    return request?.provider === 'rallar-remote-browser' ||
        request?.remoteProvider === 'rallar-remote-browser' ||
        request?.remoteBrowser === true ||
        request?.browser === 'rallar-remote-browser' ||
        control.provider === 'rallar-remote-browser' ||
        control.mode === 'remote-browser' ||
        control.remoteBrowser === true;
}

function toStringList(value: unknown): string[] {
    if (Array.isArray(value)) {
        return value
            .filter(item => typeof item === 'string' && item.trim().length > 0)
            .map(item => item.trim());
    }

    if (typeof value === 'string' && value.trim().length > 0) {
        return value
            .split(',')
            .map(item => item.trim())
            .filter(item => item.length > 0);
    }

    return [];
}

function remoteBrowserAllowedOrigins(request: any, context: any): string[] {
    const control = request?.control ?? {};
    const options = remoteBrowserOptions(context);
    return [
        ...toStringList(request.allowedOrigins),
        ...toStringList(request.remoteAllowedOrigins),
        ...toStringList(control.allowedOrigins),
        ...toStringList(options.allowedOrigins),
    ];
}

function remoteBrowserAllowedHosts(request: any, context: any): string[] {
    const control = request?.control ?? {};
    const options = remoteBrowserOptions(context);
    return [
        ...toStringList(request.allowedHosts),
        ...toStringList(request.remoteAllowedHosts),
        ...toStringList(control.allowedHosts),
        ...toStringList(options.allowedHosts),
    ];
}

function hostMatchesAllowedHost(host: string, hostname: string, allowedHost: string): boolean {
    if (allowedHost === host || allowedHost === hostname) {
        return true;
    }

    if (!allowedHost.startsWith('*.')) {
        return false;
    }

    const suffix = allowedHost.slice(1);
    return hostname.endsWith(suffix) && hostname.length > suffix.length;
}

function assertRemoteDestinationAllowed(request: any, context: any, url: string | undefined, label: string): void {
    const allowedOrigins = remoteBrowserAllowedOrigins(request, context);
    const allowedHosts = remoteBrowserAllowedHosts(request, context);
    if (allowedOrigins.length <= 0 && allowedHosts.length <= 0) {
        return;
    }

    if (!url) {
        return;
    }

    let parsed: URL;
    try {
        parsed = new URL(url);
    } catch (_ignored) {
        return;
    }

    if (allowedOrigins.includes(parsed.origin)) {
        return;
    }

    if (allowedHosts.some(allowedHost => hostMatchesAllowedHost(parsed.host, parsed.hostname, allowedHost))) {
        return;
    }

    throw new Error(`${label} destination is not allowed for remote browser execution: ${parsed.origin}`);
}

function remoteBrowserMaxPayloadBytes(request: any, context: any): number {
    const control = request?.control ?? {};
    const options = remoteBrowserOptions(context);
    const value = request.maxRemotePayloadBytes ??
        request.maxPayloadBytes ??
        control.maxPayloadBytes ??
        options.maxRemotePayloadBytes ??
        options.maxPayloadBytes ??
        1_000_000;
    const parsed = Number.parseInt(String(value), 10);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : 1_000_000;
}

function payloadByteLength(value: unknown): number {
    if (value === undefined || value === null) {
        return 0;
    }

    const text = typeof value === 'string'
        ? value
        : JSON.stringify(value) ?? '';
    return new TextEncoder().encode(text).length;
}

function assertRemotePayloadWithinLimit(request: any, context: any, value: unknown, label: string): void {
    const maxBytes = remoteBrowserMaxPayloadBytes(request, context);
    const byteLength = payloadByteLength(value);
    if (byteLength > maxBytes) {
        throw new Error(`${label} payload is too large for remote browser execution: ${byteLength} bytes exceeds ${maxBytes} bytes`);
    }
}

function toRemoteHttpBody(request: any): unknown {
    if (request.form) {
        return new URLSearchParams(request.form).toString();
    }

    return request.body !== undefined &&
            request.method !== undefined &&
            String(request.method).toUpperCase() !== 'GET'
        ? request.body
        : undefined;
}

function toRemoteHttpHeaders(request: any): Readonly<Record<string, string>> | undefined {
    if (!request.form) {
        return request.headers;
    }

    return {
        'Content-Type': 'application/x-www-form-urlencoded',
        ...request.headers,
    };
}

function toRemoteHttpResponseOptions(request: any): any {
    const responseBody = request.remoteResponseBody ??
        request.responseBodyMode ??
        request.responseBody ??
        request.bodyMode ??
        'text';
    const maxBodyChars = request.maxBodyChars ?? request.responseMaxBodyChars;

    return maxBodyChars === undefined
        ? {
            body: responseBody,
        }
        : {
            body: responseBody,
            maxBodyChars,
        };
}

function toRemoteHttpCommand(commandId: string, interaction: any, context: any): RallarBlackBoxTestCommand {
    const request = interaction.request;
    const body = toRemoteHttpBody(request);
    assertRemoteDestinationAllowed(request, context, request.url ?? request.path, 'HTTP');
    assertRemotePayloadWithinLimit(request, context, body, 'HTTP request');
    return {
        kind: 'http.request',
        commandId,
        request: {
            url: request.url,
            path: request.path,
            method: request.method,
            headers: toRemoteHttpHeaders(request),
            body,
            credentials: request.credentials,
            mode: request.mode,
        },
        response: toRemoteHttpResponseOptions(request),
        timeoutMs: request.timeoutMs,
        metadata: {
            blackBoxRunner: request,
        },
    };
}

function remoteResultValue(result: RallarRemoteBrowserControlResultEnvelope): any {
    return result.result?.value ?? result.error?.details ?? result.error ?? result.result ?? result;
}

function parseRemoteHttpBody(body: any): any {
    if (typeof body !== 'string') {
        return body;
    }

    try {
        return JSON.parse(body);
    } catch (_ignored) {
        return {};
    }
}

function toRemoteHttpResponse(result: RallarRemoteBrowserControlResultEnvelope): any {
    const value = remoteResultValue(result);
    const status = Number.parseInt(String(value?.status ?? 0), 10);
    return {
        status,
        statusText: value?.statusText ?? '',
        ok: typeof value?.ok === 'boolean'
            ? value.ok
            : status >= 200 && status < 300,
        headers: value?.headers ?? {},
        url: value?.url,
        body: value?.body,
        blackBoxAttemptNumber: 1,
        blackBoxMaxAttempts: 1,
    };
}

function withRemoteHttpDetails(status: any, details: any): any {
    return {
        ...status,
        actual: {
            ...status.actual,
            ...details,
        },
    };
}

async function executeRemoteHttpInteraction(interaction: any, config: any, context: any): Promise<any> {
    const remote = resolveRallarRemoteBrowserConfig(
        interaction.request,
        config,
        context,
        remoteBrowserOptions(context),
    );
    const fetchFn = remoteBrowserFetch(context);
    const commandId = toRallarRemoteBrowserCommandId('http', interaction);

    try {
        const command = toRemoteHttpCommand(commandId, interaction, context);
        const result = await executeRallarRemoteBrowserCommand(remote, fetchFn, context, command);
        if (!result.ok) {
            return toStatus(
                config,
                'Remote HTTP request failed',
                remoteResultValue(result),
                {
                    status: 0,
                    statusText: 'Remote command failed',
                    blackBoxAttemptNumber: 1,
                    blackBoxMaxAttempts: 1,
                },
                interaction,
                {
                    remote,
                    result,
                },
            );
        }

        const response = toRemoteHttpResponse(result);
        return withRemoteHttpDetails(
            toHttpInteractionStatus(
                config,
                interaction,
                response,
                parseRemoteHttpBody(response.body),
            ),
            {
                remote,
                commandId,
                result: remoteResultValue(result),
            },
        );
    } catch (e) {
        const error = e instanceof Error ? e : new Error(String(e));
        return {
            name: config.interactionName,
            exception: error.name === 'AbortError'
                ? 'Remote request timed out after ' + interaction.request.timeoutMs + ' ms'
                : error.message,
            status: FAILURE,
            ...toCorrelationReportFields(interaction),
            method: interaction.request.method || 'GET',
            path: interaction.request.path,
            timeoutMs: interaction.request.timeoutMs,
            scenarioExecutionNumber: config.interaction.request.scenarioExecutionNumber,
            interactionExecutionNumber: config.interaction.request.interactionExecutionNumber,
            repeatIndex: config.interaction.request.repeatIndex,
            expected: interaction.response,
            actual: {
                remote,
            },
            ...config,
        };
    }
}

function toWsUrl(request: any): string | undefined {
    return request.url || request.path;
}

function toWsReadyStateName(readyState: any): string {
    if (readyState === WebSocket.CONNECTING) {
        return 'CONNECTING';
    }
    if (readyState === WebSocket.OPEN) {
        return 'OPEN';
    }
    if (readyState === WebSocket.CLOSING) {
        return 'CLOSING';
    }
    if (readyState === WebSocket.CLOSED) {
        return 'CLOSED';
    }

    return 'UNKNOWN';
}

function toWsSocketState(ws: any): any {
    if (!ws) {
        return {
            readyState: undefined,
            readyStateName: 'MISSING',
        };
    }

    return {
        readyState: ws.readyState,
        readyStateName: toWsReadyStateName(ws.readyState),
        bufferedAmount: typeof ws.bufferedAmount === 'number'
            ? ws.bufferedAmount
            : undefined,
    };
}

function toWsSendResult(status: string, ws: any, connectionName: string, wirePayload: string, details: any = {}): any {
    return {
        status,
        connection: connectionName,
        ...toWsSocketState(ws),
        wirePayload,
        wirePayloadLength: wirePayload.length,
        ...details,
    };
}

function parseWsData(data: any): any {
    if (typeof data !== 'string') {
        return data;
    }

    try {
        return JSON.parse(data);
    } catch (_ignored) {
        return data;
    }
}

function rememberWsMessage(connectionName: string, message: any, context: any): void {
    if (!context.wsMessages[connectionName]) {
        context.wsMessages[connectionName] = [];
    }

    context.wsMessages[connectionName].push(message);
}

function rememberWsCloseEvent(connectionName: string, closeEvent: any, context: any): void {
    if (!context.wsCloseEvents[connectionName]) {
        context.wsCloseEvents[connectionName] = [];
    }

    context.wsCloseEvents[connectionName].push(closeEvent);
}

function openWs(interaction: any, config: any, context: any): Promise<any> {
    const request = interaction.request;
    const connectionName = toWsConnectionName(request);
    const url = toWsUrl(request);

    if (!url) {
        return Promise.resolve(toWsFailureStatus(config, interaction, 'WebSocket URL is missing'));
    }

    return new Promise(resolve => {
        const ws = new WebSocket(url);
        const timeoutMs = Number.parseInt(request.timeoutMs || 5000);
        let settled = false;

        const resolveOnce = (result: any): void => {
            if (settled) {
                return;
            }

            settled = true;
            clearTimeout(timeout);
            resolve(result);
        };

        const timeout = setTimeout(() => {
            resolveOnce(toWsFailureStatus(config, interaction, 'WebSocket connect timed out', {
                connection: connectionName,
                url,
                timeoutMs,
            }));

            try {
                ws.close();
            } catch (_ignored) {
                // ignored
            }
        }, timeoutMs);

        ws.onopen = () => {
            context.wsConnections[connectionName] = ws;
            context.wsMessages[connectionName] = context.wsMessages[connectionName] || [];
            context.wsCloseEvents[connectionName] = context.wsCloseEvents[connectionName] || [];

            resolveOnce(toWsSuccessStatus(config, interaction, {
                connection: connectionName,
                url,
                readyState: ws.readyState,
            }));
        };

        ws.onmessage = event => {
            rememberWsMessage(connectionName, {
                data: parseWsData(event.data),
                receivedAtEpochMs: Date.now(),
            }, context);
        };

        ws.onclose = event => {
            rememberWsCloseEvent(connectionName, {
                code: event.code,
                reason: event.reason,
                wasClean: event.wasClean,
                closedAtEpochMs: Date.now(),
            }, context);

            if (context.wsConnections[connectionName] === ws) {
                delete context.wsConnections[connectionName];
            }

            if (!settled) {
                resolveOnce(toWsFailureStatus(config, interaction, 'WebSocket closed before opening', {
                    connection: connectionName,
                    url,
                    code: event.code,
                    reason: event.reason,
                    wasClean: event.wasClean,
                }));
            }
        };

        ws.onerror = event => {
            resolveOnce(toWsFailureStatus(config, interaction, 'WebSocket connection failed', {
                connection: connectionName,
                url,
                eventType: event?.type,
                readyState: ws.readyState,
            }));
        };
    });
}

function closeWs(interaction: any, config: any, context: any): Promise<any> {
    const request = interaction.request;
    const connectionName = toWsConnectionName(request);
    const ws = context.wsConnections[connectionName];
    const closeCode = request.closeCode !== undefined ? request.closeCode : request.code;
    const closeReason = request.closeReason !== undefined ? request.closeReason : request.reason;

    if (!ws) {
        return Promise.resolve(toWsSuccessStatus(config, interaction, {
            connection: connectionName,
            closed: false,
            reason: 'WebSocket connection was not open',
        }));
    }

    try {
        if (closeCode !== undefined || closeReason !== undefined) {
            ws.close(closeCode, closeReason);
        } else {
            ws.close();
        }

        delete context.wsConnections[connectionName];

        return Promise.resolve(toWsSuccessStatus(config, interaction, {
            connection: connectionName,
            closeRequested: true,
            closed: true,
            closeCode,
            closeReason,
        }));
    } catch (e) {
        return Promise.resolve(toWsFailureStatus(config, interaction, 'Failed to close WebSocket connection', {
            connection: connectionName,
            closeCode,
            closeReason,
            exception: e instanceof Error ? e.message : String(e),
        }));
    }
}

function sendWs(interaction: any, config: any, context: any): Promise<any> {
    const request = interaction.request;
    const connectionName = toWsConnectionName(request);
    const ws = context.wsConnections[connectionName];

    if (!ws || ws.readyState !== WebSocket.OPEN) {
        return Promise.resolve(toWsFailureStatus(config, interaction, 'WebSocket connection is not open', {
            connection: connectionName,
            ...toWsSocketState(ws),
        }));
    }

    const payload = request.send !== undefined
        ? request.send
        : request.message !== undefined
            ? request.message
            : request.body;

    const wirePayload = typeof payload === 'string'
        ? payload
        : JSON.stringify(payload !== undefined ? payload : {});

    const sendStartedAtEpochMs = Date.now();
    try {
        ws.send(wirePayload);
    } catch (e) {
        const sendFailedAtEpochMs = Date.now();
        return Promise.resolve(toWsFailureStatus(config, interaction, 'WebSocket send failed', {
            connection: connectionName,
            sent: payload,
            sendResult: toWsSendResult('failed', ws, connectionName, wirePayload, {
                exception: e instanceof Error ? e.message : String(e),
            }),
            sendStartedAtEpochMs,
            sendFailedAtEpochMs,
            sendLatencyMs: sendFailedAtEpochMs - sendStartedAtEpochMs,
            exception: e instanceof Error ? e.message : String(e),
        }));
    }

    const sendEndedAtEpochMs = Date.now();
    const sendResult = toWsSendResult('sent', ws, connectionName, wirePayload);
    const details = {
        sentConnection: connectionName,
        sent: payload,
        sendResult,
        sendStartedAtEpochMs,
        sendEndedAtEpochMs,
        sendLatencyMs: sendEndedAtEpochMs - sendStartedAtEpochMs,
    };

    if (interaction.response?.messages) {
        return waitForWsMessages(interaction, config, context, details);
    }

    if (interaction.response?.message) {
        return waitForWsMessage(interaction, config, context, details);
    }

    return Promise.resolve(toWsSuccessStatus(config, interaction, {
        connection: connectionName,
        ...details,
    }));
}

function toRemoteWsPayload(request: any): unknown {
    return request.send !== undefined
        ? request.send
        : request.message !== undefined
            ? request.message
            : request.body;
}

function toRemoteWsOpenCommand(
    commandId: string,
    interaction: any,
    context: any,
): Extract<RallarBlackBoxTestCommand, { kind: 'ws.open' }> {
    const request = interaction.request;
    const url = toWsUrl(request);
    assertRemoteDestinationAllowed(request, context, url, 'WebSocket');
    return {
        kind: 'ws.open',
        commandId,
        connection: toWsConnectionName(request),
        url,
        protocols: request.protocols,
        headers: request.headers,
        timeoutMs: request.timeoutMs,
        metadata: {
            blackBoxRunner: request,
        },
    };
}

function toRemoteWsSendCommand(
    commandId: string,
    interaction: any,
    context: any,
): Extract<RallarBlackBoxTestCommand, { kind: 'ws.send' }> {
    const request = interaction.request;
    const data = toRemoteWsPayload(request);
    assertRemotePayloadWithinLimit(request, context, data, 'WebSocket send');
    return {
        kind: 'ws.send',
        commandId,
        connection: toWsConnectionName(request),
        data,
        timeoutMs: request.timeoutMs,
        metadata: {
            blackBoxRunner: request,
        },
    };
}

function toRemoteWsCloseCommand(
    commandId: string,
    interaction: any,
): Extract<RallarBlackBoxTestCommand, { kind: 'ws.close' }> {
    const request = interaction.request;
    return {
        kind: 'ws.close',
        commandId,
        connection: toWsConnectionName(request),
        code: request.closeCode !== undefined ? request.closeCode : request.code,
        reason: request.closeReason !== undefined ? request.closeReason : request.reason,
        timeoutMs: request.timeoutMs,
        metadata: {
            blackBoxRunner: request,
        },
    };
}

function toRemoteWsConfig(interaction: any, config: any, context: any): RallarRemoteBrowserConfig {
    return resolveRallarRemoteBrowserConfig(
        interaction.request,
        config,
        context,
        remoteBrowserOptions(context),
    );
}

function isRemoteWsConnection(context: any, connectionName: string): boolean {
    return context.wsConnections?.[connectionName]?.remote === true;
}

function shouldExecuteRemoteWsInteraction(interaction: any, context: any): boolean {
    const action = interaction.request.action || 'send';
    const connectionName = action === 'wait' || action === 'expect'
        ? toWsExpectedConnectionName(interaction)
        : toWsConnectionName(interaction.request);
    return isRallarRemoteBrowserRequest(interaction.request) ||
        isRemoteWsConnection(context, connectionName);
}

function startRemoteWsEventSync(
    remote: RallarRemoteBrowserConfig,
    fetchFn: RallarRemoteBrowserControlFetch,
    context: any,
): number {
    let syncing = false;
    return setInterval(() => {
        if (syncing) {
            return;
        }
        syncing = true;
        void syncRallarRemoteBrowserEvents(remote, fetchFn, context)
            .catch(() => {
                // Wait helpers surface missing events through their normal timeout diagnostics.
            })
            .finally(() => {
                syncing = false;
            });
    }, remote.pollIntervalMs) as unknown as number;
}

async function waitWithRemoteWsEventSync(
    remote: RallarRemoteBrowserConfig,
    fetchFn: RallarRemoteBrowserControlFetch,
    context: any,
    wait: () => Promise<any>,
): Promise<any> {
    await syncRallarRemoteBrowserEvents(remote, fetchFn, context);
    const interval = startRemoteWsEventSync(remote, fetchFn, context);
    try {
        return await wait();
    } finally {
        clearInterval(interval);
    }
}

function toRemoteWsFailure(config: any, interaction: any, result: string, details: any = {}): any {
    return toWsFailureStatus(config, interaction, result, details);
}

async function openRemoteWs(interaction: any, config: any, context: any): Promise<any> {
    const connectionName = toWsConnectionName(interaction.request);
    const url = toWsUrl(interaction.request);

    if (!url) {
        return toRemoteWsFailure(config, interaction, 'WebSocket URL is missing');
    }

    const remote = toRemoteWsConfig(interaction, config, context);
    const fetchFn = remoteBrowserFetch(context);
    const commandId = toRallarRemoteBrowserCommandId('ws-open', interaction);

    try {
        const command = toRemoteWsOpenCommand(commandId, interaction, context);
        const result = await executeRallarRemoteBrowserCommand(remote, fetchFn, context, command);
        if (!result.ok) {
            return toRemoteWsFailure(config, interaction, 'Remote WebSocket connect failed', {
                connection: connectionName,
                remote,
                result,
            });
        }

        context.wsConnections[connectionName] = {
            remote: true,
            readyState: 1,
            url,
            close: (code?: number, reason?: string) => {
                void executeRallarRemoteBrowserCommand(
                    remote,
                    fetchFn,
                    context,
                    {
                        ...toRemoteWsCloseCommand(`${commandId}-auto-close`, interaction),
                        code,
                        reason,
                    },
                );
            },
        };
        context.wsMessages[connectionName] = context.wsMessages[connectionName] || [];
        context.wsCloseEvents[connectionName] = context.wsCloseEvents[connectionName] || [];

        return toWsSuccessStatus(config, interaction, {
            connection: connectionName,
            url,
            readyState: 1,
            remote,
            commandId,
            result: remoteResultValue(result),
        });
    } catch (error) {
        return toRemoteWsFailure(config, interaction, 'Remote WebSocket connect failed', {
            connection: connectionName,
            remote,
            exception: error instanceof Error ? error.message : String(error),
        });
    }
}

async function sendRemoteWs(interaction: any, config: any, context: any): Promise<any> {
    const connectionName = toWsConnectionName(interaction.request);

    if (!context.wsConnections[connectionName]) {
        return toRemoteWsFailure(config, interaction, 'WebSocket connection is not open', {
            connection: connectionName,
        });
    }

    const remote = toRemoteWsConfig(interaction, config, context);
    const fetchFn = remoteBrowserFetch(context);
    const commandId = toRallarRemoteBrowserCommandId('ws-send', interaction);
    const sentPayload = toRemoteWsPayload(interaction.request);

    try {
        const command = toRemoteWsSendCommand(commandId, interaction, context);
        const sendStartedAtEpochMs = Date.now();
        const result = await executeRallarRemoteBrowserCommand(remote, fetchFn, context, command);
        const sendEndedAtEpochMs = Date.now();
        if (!result.ok) {
            return toRemoteWsFailure(config, interaction, 'Remote WebSocket send failed', {
                connection: connectionName,
                remote,
                result,
                sent: sentPayload,
                sendResult: {
                    status: 'failed',
                    connection: connectionName,
                    remoteResult: remoteResultValue(result),
                },
                sendStartedAtEpochMs,
                sendEndedAtEpochMs,
                sendLatencyMs: sendEndedAtEpochMs - sendStartedAtEpochMs,
            });
        }

        const details = {
            sentConnection: connectionName,
            sent: sentPayload,
            remote,
            commandId,
            result: remoteResultValue(result),
            sendResult: {
                status: 'sent',
                connection: connectionName,
                remoteResult: remoteResultValue(result),
            },
            sendStartedAtEpochMs,
            sendEndedAtEpochMs,
            sendLatencyMs: sendEndedAtEpochMs - sendStartedAtEpochMs,
        };

        if (interaction.response?.messages) {
            return waitWithRemoteWsEventSync(
                remote,
                fetchFn,
                context,
                () => waitForWsMessages(interaction, config, context, details),
            );
        }

        if (interaction.response?.message) {
            return waitWithRemoteWsEventSync(
                remote,
                fetchFn,
                context,
                () => waitForWsMessage(interaction, config, context, details),
            );
        }

        await syncRallarRemoteBrowserEvents(remote, fetchFn, context);
        return toWsSuccessStatus(config, interaction, {
            connection: connectionName,
            sent: sentPayload,
            remote,
            commandId,
            result: remoteResultValue(result),
            sendResult: details.sendResult,
            sendStartedAtEpochMs,
            sendEndedAtEpochMs,
            sendLatencyMs: sendEndedAtEpochMs - sendStartedAtEpochMs,
        });
    } catch (error) {
        return toRemoteWsFailure(config, interaction, 'Remote WebSocket send failed', {
            connection: connectionName,
            remote,
            sent: sentPayload,
            sendResult: {
                status: 'failed',
                connection: connectionName,
                exception: error instanceof Error ? error.message : String(error),
            },
            exception: error instanceof Error ? error.message : String(error),
        });
    }
}

async function waitRemoteWs(interaction: any, config: any, context: any): Promise<any> {
    const remote = toRemoteWsConfig(interaction, config, context);
    const fetchFn = remoteBrowserFetch(context);
    return waitWithRemoteWsEventSync(remote, fetchFn, context, () => {
        if (interaction.response?.absent !== undefined) {
            return waitForWsMessageAbsence({
                interaction,
                config,
                context,
                details: { remote },
            });
        }

        if (interaction.response?.close !== undefined) {
            return waitForWsClose(interaction, config, context, {
                remote,
            });
        }

        if (interaction.response?.messages) {
            return waitForWsMessages(interaction, config, context, {
                remote,
            });
        }

        if (interaction.response?.message) {
            return waitForWsMessage(interaction, config, context, {
                remote,
            });
        }

        return Promise.resolve(toRemoteWsFailure(
            config,
            interaction,
            'WebSocket wait expects expect.message, expect.messages, expect.absent, or expect.close',
        ));
    });
}

async function closeRemoteWs(interaction: any, config: any, context: any): Promise<any> {
    const connectionName = toWsConnectionName(interaction.request);
    const remote = toRemoteWsConfig(interaction, config, context);
    const fetchFn = remoteBrowserFetch(context);
    const commandId = toRallarRemoteBrowserCommandId('ws-close', interaction);
    const command = toRemoteWsCloseCommand(commandId, interaction);

    try {
        const result = await executeRallarRemoteBrowserCommand(remote, fetchFn, context, command);
        await syncRallarRemoteBrowserEvents(remote, fetchFn, context);
        delete context.wsConnections[connectionName];

        if (!result.ok) {
            return toRemoteWsFailure(config, interaction, 'Remote WebSocket close failed', {
                connection: connectionName,
                remote,
                result,
            });
        }

        return toWsSuccessStatus(config, interaction, {
            connection: connectionName,
            closeRequested: true,
            closed: true,
            remote,
            commandId,
            result: remoteResultValue(result),
        });
    } catch (error) {
        return toRemoteWsFailure(config, interaction, 'Remote WebSocket close failed', {
            connection: connectionName,
            remote,
            exception: error instanceof Error ? error.message : String(error),
        });
    }
}

function executeRemoteWsInteraction(interaction: any, config: any, context: any): Promise<any> {
    const action = interaction.request.action || 'send';

    if (action === 'connect' || action === 'open') {
        return openRemoteWs(interaction, config, context);
    }

    if (action === 'send') {
        return sendRemoteWs(interaction, config, context);
    }

    if (action === 'wait' || action === 'expect') {
        return waitRemoteWs(interaction, config, context);
    }

    if (action === 'close') {
        return closeRemoteWs(interaction, config, context);
    }

    return Promise.resolve(toRemoteWsFailure(config, interaction, 'Unsupported WebSocket action: ' + action));
}

function executeWsInteraction(interaction: any, config: any, context: any): Promise<any> {
    const action = interaction.request.action || 'send';

    if (shouldExecuteRemoteWsInteraction(interaction, context)) {
        return executeRemoteWsInteraction(interaction, config, context);
    }

    if (action === 'connect' || action === 'open') {
        return openWs(interaction, config, context);
    }

    if (action === 'send') {
        return sendWs(interaction, config, context);
    }

    if (action === 'wait' || action === 'expect') {
        if (interaction.response?.absent !== undefined) {
            return waitForWsMessageAbsence({ interaction, config, context });
        }

        if (interaction.response?.close !== undefined) {
            return waitForWsClose(interaction, config, context);
        }

        if (interaction.response?.messages) {
            return waitForWsMessages(interaction, config, context);
        }

        if (interaction.response?.message) {
            return waitForWsMessage(interaction, config, context);
        }

        return Promise.resolve(toWsFailureStatus(config, interaction, 'WebSocket wait expects expect.message, expect.messages, expect.absent, or expect.close'));
    }

    if (action === 'close') {
        return closeWs(interaction, config, context);
    }

    return Promise.resolve(toWsFailureStatus(config, interaction, 'Unsupported WebSocket action: ' + action));
}

function toRequest(request: any, context: any): any {
    return resolvePlaceholders(request, context);
}

function toParallelRequest(request: any, context: any): any {
    const {groups, ...parentRequest} = request;

    return {
        ...resolvePlaceholders(parentRequest, context),
        groups,
    };
}

function toOutputKey(interactionData: any): string {
    return interactionData.scenarioExecutionNumber + '-' + interactionData.name + '-' + interactionData.interactionExecutionNumber;
}

function toResultEntries(results: any): any[] {
    return Object.values(results || {})
        .sort((left: any, right: any) => {
            const leftScenario = Number(left?.scenarioExecutionNumber || 0);
            const rightScenario = Number(right?.scenarioExecutionNumber || 0);
            if (leftScenario !== rightScenario) {
                return leftScenario - rightScenario;
            }

            const leftInteraction = Number(left?.interactionExecutionNumber || 0);
            const rightInteraction = Number(right?.interactionExecutionNumber || 0);
            if (leftInteraction !== rightInteraction) {
                return leftInteraction - rightInteraction;
            }

            const leftRepeat = Number(left?.repeatIndex || 0);
            const rightRepeat = Number(right?.repeatIndex || 0);
            if (leftRepeat !== rightRepeat) {
                return leftRepeat - rightRepeat;
            }

            return String(left?.name || '').localeCompare(String(right?.name || ''));
        });
}

function toSummary(results: any, options: any, startedAtEpochMs: number, endedAtEpochMs: number): any {
    const entries = toResultEntries(results);
    const observedFailures = entries.filter(entry => entry?.status === FAILURE);
    const failures = observedFailures.filter(entry => entry?.nonBlockingFailure !== true);
    const successes = entries.filter(entry => entry?.status === SUCCESS);

    return {
        total: entries.length,
        success: successes.length,
        failure: failures.length,
        observedFailure: observedFailures.length,
        nonBlockingFailure: observedFailures.length - failures.length,
        failFast: options.failFast !== false,
        durationMs: endedAtEpochMs - startedAtEpochMs,
        firstFailure: failures.length > 0
            ? {
                resultKey: failures[0].resultKey,
                name: failures[0].name,
                transport: failures[0].transport,
                action: failures[0].action,
                connection: failures[0].connection,
                result: failures[0].result,
                exception: failures[0].exception,
                method: failures[0].method,
                path: failures[0].path,
                scenarioExecutionNumber: failures[0].scenarioExecutionNumber,
                interactionExecutionNumber: failures[0].interactionExecutionNumber,
                repeatIndex: failures[0].repeatIndex,
            }
            : undefined,
    };
}

function toReport(context: any, options: any, startedAtEpochMs: number, endedAtEpochMs: number): any {
    const resultsList = toResultEntries(context.results);
    const results = Object.fromEntries(resultsList.map((result: any) => [result.resultKey, result]));
    const resultsByName = resultsList.reduce<Record<string, any[]>>((byName, result: any) => {
        byName[result.name] = byName[result.name] || [];
        byName[result.name].push(result);
        return byName;
    }, {});

    return redactBlackBoxData({
        summary: {
            ...toSummary(context.results, options, startedAtEpochMs, endedAtEpochMs),
            runnerRunId: context.correlation.runnerRunId,
        },
        runnerRunId: context.correlation.runnerRunId,
        correlation: toPublicCorrelationConfig(context.correlation),
        results,
        resultsList,
        resultsByName,
        outputs: context.outputs,
        wsMessages: context.wsMessages,
        wsCloseEvents: context.wsCloseEvents,
        rtcConnections: context.rtcConnections,
        rtcMessages: context.rtcMessages,
        rtcDiagnostics: context.rtcDiagnostics,
        rtcCloseEvents: context.rtcCloseEvents,
        rtcProviderNames: Object.keys(context.rtcProviders || {}),
    }, context.redactions);
}

function isDryRunExecution(interaction: any, config: any, context: any): boolean {
    return interaction?.request?.dryRun === true
        || interaction?.dryRun === true
        || config?.dryRun === true
        || config?.interaction?.request?.dryRun === true
        || config?.interactionConfig?.dryRun === true
        || context?.dryRun === true
        || context?.options?.dryRun === true
        || context?.executionOptions?.dryRun === true
}

function toDryRunRtcMessage(interaction: any, message: any): any {
    return {
        data: message,
        receivedAtEpochMs: undefined,
        provider: interaction.request.provider,
        actor: interaction.request.actor,
        roomId: interaction.request.roomId,
        dryRun: true,
    };
}

function toDryRunRtcDetails(interaction: any, action: string): any {
    const details: any = {
        dryRun: true,
        normalized: {
            ...interaction.request,
            response: interaction.response,
        },
    };

    if (action === 'send') {
        details.sentConnection = interaction.request.connection;
        details.sent = toRtcPayload(interaction.request);
        details.sendResult = {
            status: 'sent',
            dryRun: true,
        };
    }

    if (interaction.response?.message !== undefined) {
        details.connection = interaction.response.connection || interaction.request.connection;
        details.matchedMessage = toDryRunRtcMessage(interaction, interaction.response.message);
        details.consumed = interaction.response.consume === true;
        details.firstPayloadLatencyMs = 0;
        details.waitedMs = 0;
    }

    if (Array.isArray(interaction.response?.messages)) {
        details.connection = interaction.response.connection || interaction.request.connection;
        details.matchedMessages = interaction.response.messages.map((message: any, index: number) => ({
            expectedMessage: message,
            matchedMessage: toDryRunRtcMessage(interaction, message),
            matchIndex: index,
        }));
        details.consumed = interaction.response.consume === true;
        details.waitedMs = 0;
    }

    return details;
}

function executeRtcInteraction(interaction: any, config: any, context: any): Promise<any> {
    const action = interaction.request.action || 'send';
    const providerName = interaction.request.provider || 'rallar';
    const provider = context.rtcProviders?.[providerName] || createMissingRtcProvider(providerName);

    if (isDryRunExecution(interaction, config, context)) {
        return Promise.resolve(toRtcSuccessStatus(config, interaction, toDryRunRtcDetails(interaction, action)))
    }

    if (action === 'connect') {
        return provider.connect(interaction, config, context);
    }

    if (action === 'send') {
        return provider.send(interaction, config, context);
    }

    if (action === 'wait' || action === 'expect') {
        return provider.wait(interaction, config, context);
    }

    if (action === 'close') {
        return provider.close(interaction, config, context);
    }

    return Promise.resolve(toRtcFailureStatus(
        config,
        interaction,
        'Unsupported RTC action: ' + action,
        {
            provider: providerName,
            supportedActions: ['connect', 'send', 'wait', 'expect', 'close'],
        },
    ));
}

function toCrdtReportFields(interaction: any): any {
    return {
        provider: interaction.request.provider,
        action: interaction.request.action,
        connection: interaction.request.connection,
        handle: interaction.request.handle,
        documentName: interaction.request.name,
        applicationId: interaction.request.applicationId,
        workspaceId: interaction.request.workspaceId,
        documentId: interaction.request.documentId,
        documentType: interaction.request.documentType,
        scope: interaction.request.scope,
        roomRef: interaction.request.roomRef,
        transportStrategy: interaction.request.transport,
        durableCatchUp: interaction.request.durableCatchUp,
    };
}

function toCrdtSuccessStatus(config: any, interaction: any, details: any = {}): any {
    return {
        name: config.interactionName,
        status: SUCCESS,
        transport: 'CRDT',
        ...toCorrelationReportFields(interaction),
        ...toCrdtReportFields(interaction),
        scenarioExecutionNumber: config.interaction.request.scenarioExecutionNumber,
        interactionExecutionNumber: config.interaction.request.interactionExecutionNumber,
        repeatIndex: config.interaction.request.repeatIndex,
        expected: interaction.response,
        actual: {
            ...toCrdtReportFields(interaction),
            ...details,
        },
        ...config,
    };
}

function toCrdtFailureStatus(config: any, interaction: any, result: string, details: any = {}): any {
    return {
        name: config.interactionName,
        status: FAILURE,
        result,
        transport: 'CRDT',
        ...toCorrelationReportFields(interaction),
        ...toCrdtReportFields(interaction),
        scenarioExecutionNumber: config.interaction.request.scenarioExecutionNumber,
        interactionExecutionNumber: config.interaction.request.interactionExecutionNumber,
        repeatIndex: config.interaction.request.repeatIndex,
        expected: interaction.response,
        actual: {
            ...toCrdtReportFields(interaction),
            ...details,
        },
        ...config,
    };
}

function toDryRunCrdtDetails(interaction: any, action: string): any {
    return {
        dryRun: true,
        action,
        provider: interaction.request.provider,
        connection: interaction.request.connection,
        handle: interaction.request.handle,
        batch: interaction.request.batch,
        transportStrategy: interaction.request.transport,
    };
}

function executeCrdtInteraction(interaction: any, config: any, context: any): Promise<any> {
    const action = interaction.request.action || 'open';
    const providerName = interaction.request.provider || 'rallar-browser';
    const provider = context.rtcProviders?.[providerName] || createMissingRtcProvider(providerName);

    if (isDryRunExecution(interaction, config, context)) {
        return Promise.resolve(toCrdtSuccessStatus(config, interaction, toDryRunCrdtDetails(interaction, action)));
    }

    if (!provider.command) {
        return Promise.resolve(toCrdtFailureStatus(
            config,
            interaction,
            'CRDT provider command support is not configured: ' + providerName,
            {
                provider: providerName,
                supportedProviders: Object.keys(context.rtcProviders || {})
                    .filter(name => Boolean(context.rtcProviders?.[name]?.command)),
            },
        ));
    }

    return provider.command(interaction, config, context);
}

function executeInteraction(interactionWithConfig: any, context: any): Promise<any> {
    const interaction = toExecutableInteraction(interactionWithConfig);

    if (!interaction) {
        return Promise.resolve();
    }

    interaction.request = interactionWithConfig.PARALLEL
        ? toParallelRequest(interaction.request, context)
        : toRequest(interaction.request, context);
    const rawResponse = interaction.response || {};
    const {actual: rawAssertActual, ...responseWithoutAssertActual} = rawResponse;
    interaction.response = resolvePlaceholders(responseWithoutAssertActual, context);
    if (interactionWithConfig.ASSERT && rawAssertActual !== undefined) {
        interaction.response.actual = rawAssertActual;
    }

    const config = {
        interactionName: toInteractionName(interactionWithConfig),
        interactionConfig: toInteractionConfig(interactionWithConfig),
        interaction,
    };

    applyInteractionCorrelation(interactionWithConfig, interaction, config, context);

    if (interactionWithConfig.ASSERT) {
        return executeAssertInteraction(interaction, config, context);
    }

    if (interactionWithConfig.SET) {
        return executeSetInteraction(interaction, config, context);
    }

    if (interactionWithConfig.PARALLEL) {
        return executeParallelInteraction(interaction, config, context);
    }

    if (interactionWithConfig.WS) {
        return executeWsInteraction(interaction, config, context);
    }

    if (interactionWithConfig.CRDT) {
        return executeCrdtInteraction(interaction, config, context);
    }

    if (interactionWithConfig.RTC || interactionWithConfig.WEBRTC) {
        return executeRtcInteraction(interaction, config, context);
    }

    if (isRallarRemoteBrowserRequest(interaction.request)) {
        return executeRemoteHttpInteraction(interaction, config, context);
    }

    return executeHttpInteraction(interaction, config);
}

function toParallelFailureStatus(config: any, interaction: any, result: string, details: any = {}): any {
    return {
        name: config.interactionName,
        status: FAILURE,
        transport: 'PARALLEL',
        action: interaction.request.action || 'run',
        result,
        ...toCorrelationReportFields(interaction),
        scenarioExecutionNumber: config.interaction.request.scenarioExecutionNumber,
        interactionExecutionNumber: config.interaction.request.interactionExecutionNumber,
        repeatIndex: config.interaction.request.repeatIndex,
        expected: interaction.response,
        actual: details,
        ...config,
    };
}

function toParallelSuccessStatus(config: any, interaction: any, actual: any): any {
    return {
        name: config.interactionName,
        status: SUCCESS,
        transport: 'PARALLEL',
        action: interaction.request.action || 'run',
        ...toCorrelationReportFields(interaction),
        scenarioExecutionNumber: config.interaction.request.scenarioExecutionNumber,
        interactionExecutionNumber: config.interaction.request.interactionExecutionNumber,
        repeatIndex: config.interaction.request.repeatIndex,
        expected: interaction.response,
        actual,
        ...config,
    };
}

async function runBoundedParallel<T, R>(
    items: T[],
    maxConcurrency: number,
    worker: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
    const results: R[] = new Array(items.length);
    let nextIndex = 0;

    async function runWorker(): Promise<void> {
        while (nextIndex < items.length) {
            const index = nextIndex;
            nextIndex++;
            results[index] = await worker(items[index], index);
        }
    }

    const workerCount = Math.max(1, Math.min(maxConcurrency, items.length));
    await Promise.all(Array.from({ length: workerCount }, () => runWorker()));

    return results;
}

async function executeParallelInteraction(interaction: any, config: any, context: any): Promise<any> {
    const groups = Array.isArray(interaction.request.groups)
        ? interaction.request.groups
        : [];

    if (groups.length <= 0) {
        return toParallelFailureStatus(config, interaction, 'Parallel step requires at least one group with steps.');
    }

    const maxConcurrency = Math.max(
        1,
        Number.parseInt(String(interaction.request.maxConcurrency || groups.length), 10) || groups.length,
    );
    const timeoutMs = Number.parseInt(String(interaction.request.timeoutMs || 0), 10);
    const groupFailFast = interaction.request.failFast !== false;
    const startedAtEpochMs = Date.now();

    const groupResults = await runBoundedParallel(groups, maxConcurrency, async (group: any, groupIndex: number) => {
        const groupStartedAtEpochMs = Date.now();
        const steps = Array.isArray(group.steps)
            ? group.steps
            : [];

        if (steps.length <= 0) {
            return {
                name: String(group.name || 'group-' + (groupIndex + 1)),
                index: group.index || groupIndex + 1,
                status: FAILURE,
                success: 0,
                failure: 1,
                result: 'Parallel group has no steps.',
                durationMs: Date.now() - groupStartedAtEpochMs,
            };
        }

        const stepResults = await executeBlackBoxRecursive(steps, 0, {
            ...context.options,
            failFast: groupFailFast,
            nonBlockingFailure: interaction.request.nonBlockingFailure === true,
        }, context);
        const resultValues = Object.values(stepResults || {}) as any[];
        const failureCount = resultValues.filter(result => result?.status === FAILURE).length;

        return {
            name: String(group.name || 'group-' + (groupIndex + 1)),
            index: group.index || groupIndex + 1,
            status: failureCount > 0 ? FAILURE : SUCCESS,
            success: resultValues.filter(result => result?.status === SUCCESS).length,
            failure: failureCount,
            resultKeys: resultValues.map(result => result?.resultKey).filter(Boolean),
            durationMs: Date.now() - groupStartedAtEpochMs,
        };
    });

    const durationMs = Date.now() - startedAtEpochMs;
    const failure = groupResults.reduce((count, group) => count + Number((group as any).failure || 0), 0);
    const success = groupResults.reduce((count, group) => count + Number((group as any).success || 0), 0);
    const timedOut = Number.isFinite(timeoutMs) && timeoutMs > 0 && durationMs > timeoutMs;
    const actual = {
        groups: groupResults,
        groupCount: groupResults.length,
        maxConcurrency,
        timeoutMs: Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : undefined,
        timedOut,
        durationMs,
        success,
        failure,
    };

    if (timedOut) {
        return toParallelFailureStatus(config, interaction, 'Parallel step exceeded timeout.', actual);
    }

    if (failure > 0) {
        return toParallelFailureStatus(config, interaction, 'Parallel step had failed child steps.', actual);
    }

    return toParallelSuccessStatus(config, interaction, actual);
}

function executeBlackBoxRecursive(
    interactions: any[],
    index: number,
    options: any = {},
    context: any,
): Promise<any> {
    const executeNext = (interactionData: any): any => {
        const storedInteractionData = storeInteractionData(
            options.nonBlockingFailure === true
                ? { ...interactionData, nonBlockingFailure: true }
                : interactionData,
            context,
        );

        const data = {
            [toResultKey(storedInteractionData)]: storedInteractionData,
        };

        if (
            storedInteractionData.status === FAILURE &&
            storedInteractionData.nonBlockingFailure !== true &&
            options.failFast !== false
        ) {
            return data;
        }

        if (index + 1 < interactions.length) {
            return executeBlackBoxRecursive(interactions, ++index, options, context)
                .then(d => {
                    return { ...data, ...d };
                });
        }

        return data;
    };

    const startedAtEpochMs = Date.now();
    const interactionWithConfig = interactions[index];

    return Promise.resolve()
        .then(() => executeInteraction(interactionWithConfig, context))
        .catch(error => {
            const interaction = toExecutableInteraction(interactionWithConfig);
            const request = interaction?.request || {};
            return {
                name: toInteractionName(interactionWithConfig),
                status: FAILURE,
                result: 'Interaction execution failed',
                exception: error instanceof Error ? error.message : String(error),
                scenarioExecutionNumber: request.scenarioExecutionNumber,
                interactionExecutionNumber: request.interactionExecutionNumber,
                repeatIndex: request.repeatIndex,
                interaction,
            };
        })
        .then(data => {
            const endedAtEpochMs = Date.now();
            return executeNext({ ...data, startedAtEpochMs, endedAtEpochMs,
                durationMs: endedAtEpochMs - startedAtEpochMs });
        });
}

function closeAllWsConnections(context: any): void {
    Object.entries(context.wsConnections)
        .forEach(([connectionName, ws]) => {
            const socket = ws as WebSocket;

            try {
                rememberWsCloseEvent(connectionName, {
                    autoCloseRequested: true,
                    readyStateBeforeClose: socket.readyState,
                    closedAtEpochMs: Date.now(),
                }, context);

                socket.close();
            } catch (e) {
                rememberWsCloseEvent(connectionName, {
                    autoCloseRequested: true,
                    autoCloseFailed: true,
                    exception: e instanceof Error ? e.message : String(e),
                    closedAtEpochMs: Date.now(),
                }, context);
            }
        });

    context.wsConnections = {};
}

function toRtcConnectionDiagnostics(connection: any): any {
    if (!connection || typeof connection !== 'object') {
        return connection;
    }

    const {
        client: _client,
        ...diagnostics
    } = connection;

    return diagnostics;
}

async function closeAllRtcConnections(context: any): Promise<void> {
    for (const [connectionName, connection] of Object.entries(context.rtcConnections || {})) {
        const rtcConnection = connection as any;
        const client = rtcConnection?.client as RtcClient | undefined;

        try {
            if (client) {
                await client.close();
            }

            rememberRtcCloseEvent(connectionName, {
                autoCloseRequested: true,
                autoCloseSucceeded: true,
                closedAtEpochMs: Date.now(),
                connection: toRtcConnectionDiagnostics(rtcConnection),
                stub: rtcConnection?.stub === true,
            }, context);
        } catch (e) {
            rememberRtcCloseEvent(connectionName, {
                autoCloseRequested: true,
                autoCloseSucceeded: false,
                autoCloseFailed: true,
                exception: e instanceof Error ? e.message : String(e),
                closedAtEpochMs: Date.now(),
                connection: toRtcConnectionDiagnostics(rtcConnection),
                stub: rtcConnection?.stub === true,
            }, context);
        }
    }

    context.rtcConnections = {};
}

export function executeBlackBox(
    interactions: any[],
    index = 0,
    options: any = {},
): Promise<any> {
    const startedAtEpochMs = Date.now();
    const context = createScenarioContext(options);

    return executeBlackBoxRecursive(interactions, index, options, context)
        .then(async () => {
            closeAllWsConnections(context);
            await closeAllRtcConnections(context);
            const endedAtEpochMs = Date.now();
            return toReport(context, options, startedAtEpochMs, endedAtEpochMs);
        })
        .catch(async e => {
            closeAllWsConnections(context);
            await closeAllRtcConnections(context);
            throw e;
        });
}
