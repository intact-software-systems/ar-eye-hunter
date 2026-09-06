// deno-lint-ignore-file no-explicit-any
import { Either } from '../../shared/resilience/Either.ts';

import { evaluateScenarioTransform } from './execution/black-box-output-transform.ts';
import { isRecord, redactBlackBoxData } from './execution/black-box-redaction.ts';
import {
    toCorrelationReportFields,
    toPublicCorrelationConfig
} from './execution/black-box-run-correlation.ts';
import {
    createMissingRtcProvider,
    createScenarioContext
} from './execution/black-box-scenario-context.ts';
import {
    storeInteractionData,
    toInteractionOutputFields,
    toResultKey
} from './execution/black-box-scenario-results.ts';
import {
    resolvePlaceholders
} from './execution/black-box-value-resolution.ts';
import { computeInteractionCorrelation } from './execution/compute-interaction-correlation.ts';
import { executeAssertInteraction } from './execution/execute-assert-interaction.ts';
import { executeRemoteHttpInteraction } from './execution/execute-remote-http-interaction.ts';
import {
    executeWsInteraction,
    rememberWsCloseEvent
} from './execution/execute-ws-interaction.ts';
import { isRallarRemoteBrowserRequest } from './execution/remote-browser-execution.ts';
import { executeHttpInteraction } from './http/execute-http-interaction.ts';
import {
    toRtcPayload,
    type RtcClient
} from './rtc-provider.ts';
import { rememberRtcCloseEvent, toRtcFailureStatus, toRtcSuccessStatus } from './rtc/rtc-wait-expectations.ts';
import { SafeOutputTransformError } from './scenario-transform/safe-output-transform.ts';

const SUCCESS = 'SUCCESS';
const FAILURE = 'FAILURE';
const INTERACTION_TRANSPORTS = ['HTTP', 'MQ', 'WS', 'RTC', 'WEBRTC', 'CRDT', 'ASSERT', 'SET', 'PARALLEL'];

interface InteractionFailureStatusInput {
    readonly config: any;
    readonly interaction: any;
    readonly result: string;
    readonly details?: any;
}
interface ConditionFailureStatusInput {
    readonly interactionWithConfig: any;
    readonly interaction: any;
    readonly config: any;
    readonly error: Error;
}
interface ExecutionReportInput {
    readonly context: any;
    readonly options: any;
    readonly startedAtEpochMs: number;
    readonly endedAtEpochMs: number;
}

interface TransportInteractionInput {
    readonly interaction: any;
    readonly config: any;
    readonly context: any;
}

interface ScenarioStepsInput {
    readonly interactions: any[];
    readonly index: number;
    readonly options: any;
    readonly context: any;
}

interface ParallelGroupInput {
    readonly group: any;
    readonly groupIndex: number;
    readonly context: any;
    readonly failFast: boolean;
    readonly nonBlockingFailure: boolean;
}
interface ParallelGroupResult {
    readonly name: string;
    readonly index: number;
    readonly status: string;
    readonly success: number;
    readonly failure: number;
    readonly durationMs: number;
    readonly result?: string;
    readonly resultKeys?: readonly string[];
}
interface ParallelSummaryInput {
    readonly groups: readonly ParallelGroupResult[];
    readonly maxConcurrency: number;
    readonly timeoutMs: number;
    readonly durationMs: number;
}
interface ParallelSummary {
    readonly groups: readonly ParallelGroupResult[];
    readonly groupCount: number;
    readonly maxConcurrency: number;
    readonly timeoutMs: number | undefined;
    readonly timedOut: boolean;
    readonly durationMs: number;
    readonly success: number;
    readonly failure: number;
}

export async function executeBlackBox(interactions: any[], index = 0, options: any = {}): Promise<any> {
    const startedAtEpochMs = Date.now();
    const context = createScenarioContext(options);
    try {
        await executeScenarioSteps({ interactions, index, options, context });
    }
    finally {
        closeAllWsConnections(context);
        await closeAllRtcConnections(context);
    }
    const endedAtEpochMs = Date.now();
    return toReport({ context, options, startedAtEpochMs, endedAtEpochMs });
}

function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
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

function toConditionFailureStatus(input: ConditionFailureStatusInput): any {
    const { interactionWithConfig, interaction, config, error } = input;
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

function evaluateInteractionCondition(interaction: any, context: any): Either<Error, boolean> {
    const condition = interaction.request.when;
    if (condition === undefined) {
        return Either.ofRight(true);
    }
    try {
        const value = isRecord(condition)
            ? evaluateScenarioTransform({ transform: condition, context, operatorPath: 'when' })
            : condition;
        return typeof value === 'boolean'
            ? Either.ofRight(value)
            : Either.ofLeft(new Error('Step condition must resolve to a boolean.'));
    }
    catch (error) {
        return Either.ofLeft(error instanceof Error ? error : new Error(String(error)));
    }
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
        ...toInteractionOutputFields(interaction),
        input: interaction.request.input
    };
}

function toSetFailureStatus(input: InteractionFailureStatusInput): any {
    const { config, interaction, result } = input;
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
        details: input.details ?? {},
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
        return toSetFailureStatus({
            config,
            interaction,
            result: 'Set step is missing output. Use output to name the stored value.'
        });
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
            return toSetFailureStatus({
                config,
                interaction,
                result: 'Set transform failed.',
                details: {
                    transform,
                    transformError: {
                        message: error instanceof Error ? error.message : String(error),
                        details: error instanceof SafeOutputTransformError ? error.details : undefined
                    }
                }
            });
        }
    }

    if (value === undefined) {
        return toSetFailureStatus({
            config,
            interaction,
            result: 'Set step is missing value. Use value, request.value, or transform.'
        });
    }

    if (Number.isFinite(delayMs) && delayMs > 0) {
        await sleep(delayMs);
    }

    return toSetSuccessStatus(config, interaction, value);
}

function toResolvedInteraction(interaction: any, context: any, transport: string): any {
    const { groups, ...parentRequest } = interaction.request;
    const rawResponse = interaction.response || {};
    const { actual, ...responseWithoutActual } = rawResponse;
    return {
        ...interaction,
        request: transport === 'PARALLEL'
            ? { ...resolvePlaceholders(parentRequest, context), groups }
            : resolvePlaceholders(interaction.request, context),
        response: {
            ...resolvePlaceholders(responseWithoutActual, context),
            ...(transport === 'ASSERT' && actual !== undefined ? { actual } : {})
        }
    };
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

function toSummary(input: ExecutionReportInput): any {
    const { context, options, startedAtEpochMs, endedAtEpochMs } = input;
    const results = context.results;
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

function toReport(input: ExecutionReportInput): any {
    const { context } = input;
    const resultsList = toResultEntries(context.results);
    const results = Object.fromEntries(resultsList.map((result: any) => [result.resultKey, result]));
    const resultsByName = resultsList.reduce<Record<string, any[]>>((byName, result: any) => {
        byName[result.name] = byName[result.name] || [];
        byName[result.name].push(result);
        return byName;
    }, {});

    return redactBlackBoxData({
        summary: {
            ...toSummary(input),
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

    return Promise.resolve(
        toRtcFailureStatus({
            config: config,
            interaction: interaction,
            result: 'Unsupported RTC action: ' + action,
            details: {
                provider: providerName,
                supportedActions: ['connect', 'send', 'wait', 'expect', 'close']
            }
        })
    );
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

function toCrdtFailureStatus(input: InteractionFailureStatusInput): any {
    const { config, interaction, result } = input;
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
            ...(input.details ?? {})
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
        return Promise.resolve(toCrdtFailureStatus({
            config,
            interaction,
            result: 'CRDT provider command support is not configured: ' + providerName,
            details: {
                provider: providerName,
                supportedProviders: Object.keys(context.rtcProviders || {})
                    .filter((name) => Boolean(context.rtcProviders?.[name]?.command))
            }
        }));
    }

    return provider.command(interaction, config, context);
}

function executeInteraction(interactionWithConfig: any, context: any): Promise<any> {
    const sourceInteraction = toExecutableInteraction(interactionWithConfig);
    if (!sourceInteraction) {
        return Promise.resolve();
    }

    const condition = evaluateInteractionCondition(sourceInteraction, context);
    const transport = interactionTransport(interactionWithConfig);
    const resolvedInteraction = condition.right === true
        ? toResolvedInteraction(sourceInteraction, context, transport)
        : sourceInteraction;
    const interaction = {
        ...resolvedInteraction,
        request: computeInteractionCorrelation({
            request: resolvedInteraction.request,
            transport,
            interactionName: toInteractionName(interactionWithConfig),
            correlationConfig: context.correlation,
            runIndex: context.options?.runIndex
        })
    };
    const config = toInteractionExecutionConfig(interactionWithConfig, interaction);
    if (condition.left !== undefined) {
        return Promise.resolve(toConditionFailureStatus({
            interactionWithConfig,
            interaction,
            config,
            error: condition.left
        }));
    }
    if (!condition.right) {
        return Promise.resolve(toSkippedInteractionStatus(interactionWithConfig, interaction, config));
    }
    return executeTransportInteraction(transport, { interaction, config, context });
}

function executeTransportInteraction(transport: string, input: TransportInteractionInput): Promise<any> {
    const { interaction, config, context } = input;
    switch (transport) {
        case 'ASSERT':
            return executeAssertInteraction(interaction, config, context);
        case 'SET':
            return executeSetInteraction(interaction, config, context);
        case 'PARALLEL':
            return executeParallelInteraction(interaction, config, context);
        case 'WS':
            return executeWsInteraction(interaction, config, context);
        case 'CRDT':
            return executeCrdtInteraction(interaction, config, context);
        case 'RTC':
        case 'WEBRTC':
            return executeRtcInteraction(interaction, config, context);
        default:
            return isRallarRemoteBrowserRequest(interaction.request)
                ? executeRemoteHttpInteraction(interaction, config, context)
                : executeHttpInteraction(interaction, config);
    }
}

function toParallelFailureStatus(input: InteractionFailureStatusInput): any {
    const { config, interaction, result } = input;
    const details = input.details ?? {};
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
    const groups = Array.isArray(interaction.request.groups) ? interaction.request.groups : [];
    if (groups.length === 0) {
        return toParallelFailureStatus({
            config,
            interaction,
            result: 'Parallel step requires at least one group with steps.'
        });
    }
    const maxConcurrency = Math.max(
        1,
        Number.parseInt(String(interaction.request.maxConcurrency || groups.length), 10) || groups.length
    );
    const timeoutMs = Number.parseInt(String(interaction.request.timeoutMs || 0), 10);
    const startedAtEpochMs = Date.now();
    const groupResults = await runBoundedParallel(
        groups,
        maxConcurrency,
        (group: any, groupIndex: number) =>
            executeParallelGroup({
                group,
                groupIndex,
                context,
                failFast: interaction.request.failFast !== false,
                nonBlockingFailure: interaction.request.nonBlockingFailure === true
            })
    );
    const actual = computeParallelSummary({
        groups: groupResults,
        maxConcurrency,
        timeoutMs,
        durationMs: Date.now() - startedAtEpochMs
    });
    if (actual.timedOut || actual.failure > 0) {
        return toParallelFailureStatus({
            config,
            interaction,
            details: actual,
            result: actual.timedOut ? 'Parallel step exceeded timeout.' : 'Parallel step had failed child steps.'
        });
    }
    return toParallelSuccessStatus(config, interaction, actual);
}

async function executeParallelGroup(input: ParallelGroupInput): Promise<ParallelGroupResult> {
    const { group, groupIndex, context } = input;
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

    const stepResults = await executeScenarioSteps({
        interactions: steps,
        index: 0,
        options: {
            ...context.options,
            failFast: input.failFast,
            nonBlockingFailure: input.nonBlockingFailure
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
}

function computeParallelSummary(input: ParallelSummaryInput): ParallelSummary {
    const failure = input.groups.reduce((count, group) => count + group.failure, 0);
    const success = input.groups.reduce((count, group) => count + group.success, 0);
    const timeoutMs = Number.isFinite(input.timeoutMs) && input.timeoutMs > 0 ? input.timeoutMs : undefined;
    return {
        ...input,
        groupCount: input.groups.length,
        timeoutMs,
        timedOut: timeoutMs !== undefined && input.durationMs > timeoutMs,
        success,
        failure
    };
}

async function executeScenarioSteps(input: ScenarioStepsInput): Promise<any> {
    const { interactions, options, context } = input;
    const results: Record<string, any> = {};
    for (let index = input.index; index < interactions.length; index++) {
        const interactionData = await executeMeasuredInteraction(interactions[index], context);
        const stored = storeInteractionData(
            options.nonBlockingFailure === true ? { ...interactionData, nonBlockingFailure: true } : interactionData,
            context
        );
        results[toResultKey(stored)] = stored;
        if (stored.status === FAILURE && stored.nonBlockingFailure !== true && options.failFast !== false) {
            break;
        }
    }
    return results;
}

async function executeMeasuredInteraction(interactionWithConfig: any, context: any): Promise<any> {
    const startedAtEpochMs = Date.now();
    let result: any;
    try {
        result = await executeInteraction(interactionWithConfig, context);
    }
    catch (error) {
        const interaction = toExecutableInteraction(interactionWithConfig);
        const request = interaction?.request || {};
        result = {
            name: toInteractionName(interactionWithConfig),
            status: FAILURE,
            result: 'Interaction execution failed',
            exception: error instanceof Error ? error.message : String(error),
            scenarioExecutionNumber: request.scenarioExecutionNumber,
            interactionExecutionNumber: request.interactionExecutionNumber,
            repeatIndex: request.repeatIndex,
            interaction
        };
    }
    const endedAtEpochMs = Date.now();
    return withMaxDurationBound({
        ...result,
        startedAtEpochMs,
        endedAtEpochMs,
        durationMs: endedAtEpochMs - startedAtEpochMs
    });
}

// A bound never masks the step's own failure: only a step that succeeded and
// overran expect.maxDurationMs is flipped, keeping its original actual data.
function withMaxDurationBound(interactionData: any): any {
    const response = interactionData.expected;
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
