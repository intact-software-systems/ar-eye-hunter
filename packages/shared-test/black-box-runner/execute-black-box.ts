// deno-lint-ignore-file no-explicit-any
import { compareJson, COMPARISON, toConfig } from '../json-compare/CompareJson.ts';
import { evaluateScenarioTransform } from './execution/black-box-output-transform.ts';
import { isRecord, redactBlackBoxData } from './execution/black-box-redaction.ts';
import {
    stringOption,
    toCorrelationReportFields,
    toPublicCorrelationConfig,
    type RunnerCorrelationConfig
} from './execution/black-box-run-correlation.ts';
import { resolveBlackBoxVariables } from './execution/black-box-run-secrets.ts';
import {
    createMissingRtcProvider,
    createScenarioContext
} from './execution/black-box-scenario-context.ts';
import {
    storeInteractionData,
    toResultKey
} from './execution/black-box-scenario-results.ts';
import {
    resolveAssertActual,
    resolvePath,
    resolvePlaceholders
} from './execution/black-box-value-resolution.ts';
import { executeRemoteHttpInteraction } from './execution/execute-remote-http-interaction.ts';
import {
    executeWsInteraction,
    rememberWsCloseEvent
} from './execution/execute-ws-interaction.ts';
import { isRallarRemoteBrowserRequest } from './execution/remote-browser-execution.ts';
import { validateAssertValueComparators } from './expectations/assert-value-comparators.ts';
import { executeHttpInteraction } from './http/execute-http-interaction.ts';
import {
    rememberRtcCloseEvent,
    toRtcFailureStatus,
    toRtcPayload,
    toRtcSuccessStatus,
    type RtcClient
} from './rtc-provider.ts';
import { SafeOutputTransformError } from './scenario-transform/safe-output-transform.ts';
const SUCCESS = 'SUCCESS';
const FAILURE = 'FAILURE';
const INTERACTION_TRANSPORTS = ['HTTP', 'MQ', 'WS', 'RTC', 'WEBRTC', 'CRDT', 'ASSERT', 'SET', 'PARALLEL'];
function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

function toOutputReportFields(interaction: any): any {
    return {
        output: interaction.request.output,
        outputPath: interaction.request.outputPath,
        outputs: interaction.request.outputs,
        transform: interaction.request.transform,
        secret: interaction.request.secret,
        redact: interaction.request.redact,
        redactAs: interaction.request.redactAs
    };
}

function toInteractionName(interactionWithConfig: any): string {
    return Object.keys(interactionWithConfig)
        .filter((key) => !INTERACTION_TRANSPORTS.includes(key))[0];
}

function interactionTransport(interactionWithConfig: any): string {
    return INTERACTION_TRANSPORTS.find((transport) => interactionWithConfig[transport] !== undefined) || 'UNKNOWN';
}

function conditionedAction(interactionWithConfig: any, interaction: any): string {
    const transport = interactionTransport(interactionWithConfig);
    return String(
        interaction.request.action ||
            (transport === 'HTTP' || transport === 'MQ' ? interaction.request.method : undefined) ||
            transport
    ).toLowerCase();
}

function toSkippedInteractionStatus(
    interactionWithConfig: any,
    interaction: any,
    config: any
): any {
    return {
        name: config.interactionName,
        status: SUCCESS,
        transport: interactionTransport(interactionWithConfig),
        action: 'skip',
        skipped: true,
        skippedAction: conditionedAction(interactionWithConfig, interaction),
        result: 'Step condition evaluated to false.',
        ...toCorrelationReportFields(interaction),
        scenarioExecutionNumber: interaction.request.scenarioExecutionNumber,
        interactionExecutionNumber: interaction.request.interactionExecutionNumber,
        repeatIndex: interaction.request.repeatIndex,
        expected: interaction.response,
        actual: { condition: false },
        ...config
    };
}

function toConditionFailureStatus(
    interactionWithConfig: any,
    interaction: any,
    config: any,
    error: Error
): any {
    return {
        name: config.interactionName,
        status: FAILURE,
        transport: interactionTransport(interactionWithConfig),
        action: 'condition',
        result: 'Step condition failed.',
        ...toCorrelationReportFields(interaction),
        scenarioExecutionNumber: interaction.request.scenarioExecutionNumber,
        interactionExecutionNumber: interaction.request.interactionExecutionNumber,
        repeatIndex: interaction.request.repeatIndex,
        expected: interaction.response,
        actual: undefined,
        details: {
            condition: interaction.request.when,
            conditionError: {
                message: error instanceof Error ? error.message : String(error),
                details: error instanceof SafeOutputTransformError ? error.details : undefined
            }
        },
        ...config
    };
}

function evaluateInteractionCondition(interaction: any, context: any): boolean {
    const condition = interaction.request.when;
    const value = isRecord(condition)
        ? evaluateScenarioTransform({
            transform: condition,
            context,
            operatorPath: 'when'
        })
        : condition;
    if (typeof value !== 'boolean') {
        throw new Error('Step condition must resolve to a boolean.');
    }
    return value;
}

function toInteractionConfig(interactionWithConfig: any): any {
    const name = toInteractionName(interactionWithConfig);

    return {
        interactionName: name,
        ...interactionWithConfig[name]
    };
}

function toInteractionExecutionConfig(interactionWithConfig: any, interaction: any): any {
    return {
        interactionName: toInteractionName(interactionWithConfig),
        interactionConfig: toInteractionConfig(interactionWithConfig),
        interaction
    };
}

function toExecutableInteraction(interaction: any): any {
    return interaction?.HTTP ||
        interaction?.MQ ||
        interaction?.WS ||
        interaction?.RTC ||
        interaction?.WEBRTC ||
        interaction?.CRDT ||
        interaction?.ASSERT ||
        interaction?.SET ||
        interaction?.PARALLEL;
}

function toRunnerStepId(
    correlation: RunnerCorrelationConfig,
    request: any,
    interactionName: string,
    options: any = {}
): string {
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
        repeatIndex
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
        interactionName: config.interactionName
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
            runnerStepId: correlation.runnerStepId
        }
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
            payload: false
        }
    };
    request.runnerRunId = correlation.runnerRunId;
    request.runnerStepId = correlation.runnerStepId;

    if (correlationConfig.injectHeaders && interactionWithConfig.HTTP) {
        request.headers = {
            ...(isRecord(request.headers) ? request.headers : {}),
            [correlationConfig.runIdHeader]: correlation.runnerRunId,
            [correlationConfig.stepIdHeader]: correlation.runnerStepId
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
            correlationConfig.payloadField
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
        input: interaction.request.input
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
        ...config
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
        if (typeof collector !== 'function') {
            throw new Error('State-write evidence collector is unavailable.');
        }
        value = await collector(evidence);
    }
    if (!output) {
        return toSetFailureStatus(
            config,
            interaction,
            'Set step is missing output. Use output to name the stored value.'
        );
    }

    if (transform !== undefined) {
        try {
            value = evaluateScenarioTransform({
                transform,
                context,
                operatorPath: `set.${String(output)}`
            });
        }
        catch (error) {
            return toSetFailureStatus(
                config,
                interaction,
                'Set transform failed.',
                {
                    transform,
                    transformError: {
                        message: error instanceof Error ? error.message : String(error),
                        details: error instanceof SafeOutputTransformError ? error.details : undefined
                    }
                }
            );
        }
    }

    if (value === undefined) {
        return toSetFailureStatus(
            config,
            interaction,
            'Set step is missing value. Use value, request.value, or transform.'
        );
    }

    if (Number.isFinite(delayMs) && delayMs > 0) {
        await sleep(delayMs);
    }

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
        input: interaction.request.input
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
        ...config
    };
}

function monotonicComparisonFailures(actual: any, paths: unknown): any[] {
    if (!Array.isArray(paths)) {
        return [];
    }

    return paths.flatMap<any>((path) => {
        if (typeof path !== 'string' || path.length <= 0) {
            return [{ path, error: 'Monotonic assertion paths must be non-empty strings.' }];
        }

        let values: unknown;
        try {
            values = resolvePath(path, actual);
        }
        catch (error) {
            return [{
                path,
                error: error instanceof Error ? error.message : String(error)
            }];
        }

        if (!Array.isArray(values) || values.length <= 0) {
            return [{ path, values, error: 'Monotonic assertion path must resolve to a non-empty array.' }];
        }

        const numericValues = values.map((value) => Number(value));
        if (numericValues.some((value) => !Number.isFinite(value))) {
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
                current: numericValues[regressionIndex]
            }];
    });
}

function toResolvedAssertActual(interaction: any, context: any): any {
    return interaction.response.actual !== undefined
        ? isRecord(interaction.response.actual) && interaction.response.actual.transform !== undefined
            ? evaluateScenarioTransform({
                transform: interaction.response.actual.transform,
                context,
                operatorPath: 'assert.actual'
            })
            : resolveAssertActual(
                interaction.response.actual,
                context,
                interaction.response.missingActualValue
            )
        : interaction.request.actual;
}

function toAssertAnyOfStatus(interaction: any, config: any, actual: any): any {
    const expectedAlternatives = interaction.response.anyOf;
    const comparisons = expectedAlternatives.map((expectedValue: any) =>
        compareJson(
            expectedValue,
            actual,
            toConfig(
                interaction.response?.comparison || COMPARISON.COMPATIBLE,
                interaction.response?.ignoreJsonKeys || [],
                interaction.response?.ignoreJsonPaths || []
            )
        )
    );
    const matchedIndex = comparisons.findIndex((result: any) => result.isEqual);

    if (matchedIndex < 0) {
        return toAssertFailureStatus(config, interaction, actual, 'Assert comparison failed', {
            anyOf: expectedAlternatives,
            comparisons
        });
    }

    return toAssertSuccessStatus(config, interaction, actual, {
        anyOfMatchedIndex: matchedIndex,
        comparison: comparisons[matchedIndex]
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
                'Use expect.body, expect.expect, expect.expected, or expect.comparators.'
        ));
    }

    if (actual === undefined) {
        return Promise.resolve(toAssertFailureStatus(
            config,
            interaction,
            actual,
            'Assert step is missing actual value. Use actual or expect.actual.'
        ));
    }

    const monotonicFailures = monotonicComparisonFailures(
        actual,
        interaction.response.monotonicPaths
    );
    if (monotonicFailures.length > 0) {
        return Promise.resolve(toAssertFailureStatus(
            config,
            interaction,
            actual,
            'Assert monotonic comparison failed',
            {
                monotonicPaths: interaction.response.monotonicPaths,
                failures: monotonicFailures
            }
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
                failures: comparatorIssues
            }
        ));
    }

    if (expectedAlternatives.length > 0) {
        return Promise.resolve(toAssertAnyOfStatus(interaction, config, actual));
    }

    if (expected === undefined) {
        return Promise.resolve(toAssertSuccessStatus(config, interaction, actual, {
            comparators
        }));
    }

    const comparisonResult = compareJson(
        expected,
        actual,
        toConfig(
            interaction.response?.comparison || COMPARISON.COMPATIBLE,
            interaction.response?.ignoreJsonKeys || [],
            interaction.response?.ignoreJsonPaths || []
        )
    );

    if (!comparisonResult.isEqual) {
        return Promise.resolve(toAssertFailureStatus(
            config,
            interaction,
            actual,
            'Assert comparison failed',
            comparisonResult
        ));
    }

    return Promise.resolve(toAssertSuccessStatus(config, interaction, actual, comparisonResult));
}

function toRequest(request: any, context: any): any {
    return resolvePlaceholders(request, context);
}

function toParallelRequest(request: any, context: any): any {
    const { groups, ...parentRequest } = request;

    return {
        ...resolvePlaceholders(parentRequest, context),
        groups
    };
}

function toOutputKey(interactionData: any): string {
    return interactionData.scenarioExecutionNumber + '-' + interactionData.name + '-' +
        interactionData.interactionExecutionNumber;
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
    const observedFailures = entries.filter((entry) => entry?.status === FAILURE);
    const failures = observedFailures.filter((entry) => entry?.nonBlockingFailure !== true);
    const successes = entries.filter((entry) => entry?.status === SUCCESS);

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
                repeatIndex: failures[0].repeatIndex
            }
            : undefined
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
            runnerRunId: context.correlation.runnerRunId
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
        rtcProviderNames: Object.keys(context.rtcProviders || {})
    }, context.redactions);
}

function isDryRunExecution(interaction: any, config: any, context: any): boolean {
    return interaction?.request?.dryRun === true ||
        interaction?.dryRun === true ||
        config?.dryRun === true ||
        config?.interaction?.request?.dryRun === true ||
        config?.interactionConfig?.dryRun === true ||
        context?.dryRun === true ||
        context?.options?.dryRun === true ||
        context?.executionOptions?.dryRun === true;
}

function toDryRunRtcMessage(interaction: any, message: any): any {
    return {
        data: message,
        receivedAtEpochMs: undefined,
        provider: interaction.request.provider,
        actor: interaction.request.actor,
        roomId: interaction.request.roomId,
        dryRun: true
    };
}

function toDryRunRtcDetails(interaction: any, action: string): any {
    const details: any = {
        dryRun: true,
        normalized: {
            ...interaction.request,
            response: interaction.response
        }
    };

    if (action === 'send') {
        details.sentConnection = interaction.request.connection;
        details.sent = toRtcPayload(interaction.request);
        details.sendResult = {
            status: 'sent',
            dryRun: true
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
            matchIndex: index
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
        return Promise.resolve(toRtcSuccessStatus(config, interaction, toDryRunRtcDetails(interaction, action)));
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
            supportedActions: ['connect', 'send', 'wait', 'expect', 'close']
        }
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
        durableCatchUp: interaction.request.durableCatchUp
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
            ...details
        },
        ...config
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
            ...details
        },
        ...config
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
        transportStrategy: interaction.request.transport
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
                    .filter((name) => Boolean(context.rtcProviders?.[name]?.command))
            }
        ));
    }

    return provider.command(interaction, config, context);
}

function executeInteraction(interactionWithConfig: any, context: any): Promise<any> {
    const interaction = toExecutableInteraction(interactionWithConfig);

    if (!interaction) {
        return Promise.resolve();
    }

    if (interaction.request.when !== undefined) {
        try {
            if (!evaluateInteractionCondition(interaction, context)) {
                const config = toInteractionExecutionConfig(interactionWithConfig, interaction);
                applyInteractionCorrelation(interactionWithConfig, interaction, config, context);
                return Promise.resolve(toSkippedInteractionStatus(
                    interactionWithConfig,
                    interaction,
                    config
                ));
            }
        }
        catch (error) {
            const conditionError = error instanceof Error ? error : new Error(String(error));
            const config = toInteractionExecutionConfig(interactionWithConfig, interaction);
            applyInteractionCorrelation(interactionWithConfig, interaction, config, context);
            return Promise.resolve(toConditionFailureStatus(
                interactionWithConfig,
                interaction,
                config,
                conditionError
            ));
        }
    }

    interaction.request = interactionWithConfig.PARALLEL
        ? toParallelRequest(interaction.request, context)
        : toRequest(interaction.request, context);
    const rawResponse = interaction.response || {};
    const { actual: rawAssertActual, ...responseWithoutAssertActual } = rawResponse;
    interaction.response = resolvePlaceholders(responseWithoutAssertActual, context);
    if (interactionWithConfig.ASSERT && rawAssertActual !== undefined) {
        interaction.response.actual = rawAssertActual;
    }

    const config = toInteractionExecutionConfig(interactionWithConfig, interaction);
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
        ...config
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
        ...config
    };
}

async function runBoundedParallel<T, R>(
    items: T[],
    maxConcurrency: number,
    worker: (item: T, index: number) => Promise<R>
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
        Number.parseInt(String(interaction.request.maxConcurrency || groups.length), 10) || groups.length
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
                durationMs: Date.now() - groupStartedAtEpochMs
            };
        }

        const stepResults = await executeBlackBoxRecursive({
            interactions: steps,
            index: 0,
            options: {
                ...context.options,
                failFast: groupFailFast,
                nonBlockingFailure: interaction.request.nonBlockingFailure === true
            },
            context
        });
        const resultValues = Object.values(stepResults || {}) as any[];
        const failureCount = resultValues.filter((result) => result?.status === FAILURE).length;

        return {
            name: String(group.name || 'group-' + (groupIndex + 1)),
            index: group.index || groupIndex + 1,
            status: failureCount > 0 ? FAILURE : SUCCESS,
            success: resultValues.filter((result) => result?.status === SUCCESS).length,
            failure: failureCount,
            resultKeys: resultValues.map((result) => result?.resultKey).filter(Boolean),
            durationMs: Date.now() - groupStartedAtEpochMs
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
        failure
    };

    if (timedOut) {
        return toParallelFailureStatus(config, interaction, 'Parallel step exceeded timeout.', actual);
    }

    if (failure > 0) {
        return toParallelFailureStatus(config, interaction, 'Parallel step had failed child steps.', actual);
    }

    return toParallelSuccessStatus(config, interaction, actual);
}

interface ExecuteBlackBoxRecursiveInput {
    readonly interactions: any[];
    readonly index: number;
    readonly options: any;
    readonly context: any;
}

function executeBlackBoxRecursive(input: ExecuteBlackBoxRecursiveInput): Promise<any> {
    const { interactions, index, options, context } = input;
    const executeNext = (interactionData: any): any => {
        const storedInteractionData = storeInteractionData(
            options.nonBlockingFailure === true
                ? { ...interactionData, nonBlockingFailure: true }
                : interactionData,
            context
        );

        const data = {
            [toResultKey(storedInteractionData)]: storedInteractionData
        };

        if (
            storedInteractionData.status === FAILURE &&
            storedInteractionData.nonBlockingFailure !== true &&
            options.failFast !== false
        ) {
            return data;
        }

        if (index + 1 < interactions.length) {
            return executeBlackBoxRecursive({
                interactions,
                index: index + 1,
                options,
                context
            })
                .then((d) => {
                    return { ...data, ...d };
                });
        }

        return data;
    };

    const startedAtEpochMs = Date.now();
    const interactionWithConfig = interactions[index];

    return Promise.resolve()
        .then(() => executeInteraction(interactionWithConfig, context))
        .catch((error) => {
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
                interaction
            };
        })
        .then((data) => {
            const endedAtEpochMs = Date.now();
            return executeNext(
                withMaxDurationBound({
                    ...data,
                    startedAtEpochMs,
                    endedAtEpochMs,
                    durationMs: endedAtEpochMs - startedAtEpochMs
                }, interactionWithConfig)
            );
        });
}

// A bound never masks the step's own failure: only a step that succeeded and
// overran expect.maxDurationMs is flipped, keeping its original actual data.
function withMaxDurationBound(interactionData: any, interactionWithConfig: any): any {
    const response = toExecutableInteraction(interactionWithConfig)?.response;
    const maxDurationMs = Number.parseInt(String(response?.maxDurationMs ?? ''), 10);

    if (!Number.isFinite(maxDurationMs) || maxDurationMs <= 0) {
        return interactionData;
    }

    if (interactionData.status !== SUCCESS || interactionData.durationMs <= maxDurationMs) {
        return {
            ...interactionData,
            maxDurationMs
        };
    }

    return {
        ...interactionData,
        status: FAILURE,
        result: 'Step duration exceeded expect.maxDurationMs',
        maxDurationMs
    };
}

function closeAllWsConnections(context: any): void {
    Object.entries(context.wsConnections)
        .forEach(([connectionName, ws]) => {
            const socket = ws as WebSocket;

            try {
                rememberWsCloseEvent(connectionName, {
                    autoCloseRequested: true,
                    readyStateBeforeClose: socket.readyState,
                    closedAtEpochMs: Date.now()
                }, context);

                socket.close();
            }
            catch (e) {
                rememberWsCloseEvent(connectionName, {
                    autoCloseRequested: true,
                    autoCloseFailed: true,
                    exception: e instanceof Error ? e.message : String(e),
                    closedAtEpochMs: Date.now()
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
                stub: rtcConnection?.stub === true
            }, context);
        }
        catch (e) {
            rememberRtcCloseEvent(connectionName, {
                autoCloseRequested: true,
                autoCloseSucceeded: false,
                autoCloseFailed: true,
                exception: e instanceof Error ? e.message : String(e),
                closedAtEpochMs: Date.now(),
                connection: toRtcConnectionDiagnostics(rtcConnection),
                stub: rtcConnection?.stub === true
            }, context);
        }
    }

    context.rtcConnections = {};
}

export function executeBlackBox(
    interactions: any[],
    index = 0,
    options: any = {}
): Promise<any> {
    const startedAtEpochMs = Date.now();
    const context = createScenarioContext(options);

    return executeBlackBoxRecursive({ interactions, index, options, context })
        .then(async () => {
            closeAllWsConnections(context);
            await closeAllRtcConnections(context);
            const endedAtEpochMs = Date.now();
            return toReport(context, options, startedAtEpochMs, endedAtEpochMs);
        })
        .catch(async (e) => {
            closeAllWsConnections(context);
            await closeAllRtcConnections(context);
            throw e;
        });
}

export { redactBlackBoxData, resolveBlackBoxVariables };
