// deno-lint-ignore-file no-explicit-any
import { compareJson, COMPARISON, toConfig } from '../json-compare/CompareJson.ts';
import {
    createMissingRtcProvider,
    rememberRtcCloseEvent,
    type RtcClient,
    type RtcProvider,
    toRtcFailureStatus, toRtcSuccessStatus,
} from './rtc-provider.ts';
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

const SUCCESS = 'SUCCESS';
const FAILURE = 'FAILURE';

function createRtcProviders(): Record<string, RtcProvider> {
    return {
        rallar: createRallarWebRtcWebSocketSignalingProvider(),
        'rallar-stub': createRallarStubRtcProvider(),
        'rallar-memory': createRallarInMemoryProvider(),
        'rallar-browser': createRallarBrowserRtcProvider(),
        'rallar-remote-browser': createRallarRemoteBrowserRtcProvider(),
    };
}

function createScenarioContext(options: any = {}): any {
    return {
        variables: options.variables || {},
        outputs: {},
        results: {},
        resultsList: [],
        resultsByName: {},
        wsConnections: {},
        wsMessages: {},
        wsCloseEvents: {},
        rtcConnections: {},
        rtcMessages: {},
        rtcCloseEvents: {},
        rtcProviders: {
            ...createRtcProviders(),
            ...options.rtcProviders,
        },
        options,
        dryRun: options?.dryRun === true,
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

function stringifyResolvedValue(value: any): string {
    if (value === undefined || value === null) {
        return String(value);
    }

    return typeof value === 'string'
        ? value
        : JSON.stringify(value);
}

function resolveStringPlaceholders(value: string, context: any): any {
    const exactPlaceholderMatch = value.match(/^\{([^{}]+)}$/);

    if (exactPlaceholderMatch) {
        return resolvePath(exactPlaceholderMatch[1], toResolverRoot(context));
    }

    return value.replaceAll(/\{([^{}]+)}/g, (_match, path) => {
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
        return Object.fromEntries(
            Object.entries(value)
                .map(([key, nested]) => [key, resolvePlaceholders(nested, context)])
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

function storeInteractionData(interactionData: any, context: any): void {
    if (!interactionData || !interactionData.name) {
        return;
    }

    const resultKey = toResultKey(interactionData);

    const resultWithKey = {
        ...interactionData,
        resultKey,
    };

    context.results[resultKey] = resultWithKey;
    context.resultsList.push(resultWithKey);

    if (!context.resultsByName[interactionData.name]) {
        context.resultsByName[interactionData.name] = [];
    }

    context.resultsByName[interactionData.name].push(resultWithKey);

    if (interactionData.output) {
        context.outputs[interactionData.output] = interactionData.actual;
    }
}

function sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
}

function toRetryPolicy(request: any): any {
    const retry = request?.resilience?.retry || request?.retry || {};

    return {
        maxAttempts: Number.parseInt(retry.maxAttempts || 1),
        backoffMs: Number.parseInt(retry.backoffMs || 0),
        backoffMultiplier: Number.parseFloat(retry.backoffMultiplier || 1),
        onStatus: retry.onStatus || [],
        onException: retry.onException !== false,
    };
}

function shouldRetryStatus(response: any, retryPolicy: any): boolean {
    return retryPolicy.onStatus
        .map((status: any) => Number.parseInt(status))
        .includes(response.status);
}

function toBackoffMs(retryPolicy: any, attemptNumber: number): number {
    return retryPolicy.backoffMs * Math.pow(retryPolicy.backoffMultiplier, attemptNumber - 1);
}

async function fetchWithRetry(request: any): Promise<any> {
    const retryPolicy = toRetryPolicy(request);
    const maxAttempts = Number.isFinite(retryPolicy.maxAttempts) && retryPolicy.maxAttempts > 0
        ? retryPolicy.maxAttempts
        : 1;

    let lastException: any;

    for (let attemptNumber = 1; attemptNumber <= maxAttempts; attemptNumber++) {
        try {
            const response = await fetchDataBasic(request) as any;

            response.blackBoxAttemptNumber = attemptNumber;
            response.blackBoxMaxAttempts = maxAttempts;

            if (attemptNumber < maxAttempts && shouldRetryStatus(response, retryPolicy)) {
                const backoffMs = toBackoffMs(retryPolicy, attemptNumber);
                if (backoffMs > 0) {
                    await sleep(backoffMs);
                }
                continue;
            }

            return response;
        } catch (e) {
            lastException = e instanceof Error
                ? e
                : new Error(String(e));

            lastException.blackBoxAttemptNumber = attemptNumber;
            lastException.blackBoxMaxAttempts = maxAttempts;

            if (!retryPolicy.onException || attemptNumber >= maxAttempts) {
                throw lastException;
            }

            const backoffMs = toBackoffMs(retryPolicy, attemptNumber);
            if (backoffMs > 0) {
                await sleep(backoffMs);
            }
        }
    }

    throw lastException || new Error('Request failed without response');
}

function toBody(request: any): BodyInit | undefined {
    if (request.form) {
        return new URLSearchParams(request.form);
    }

    return request.body && request.method !== undefined && request.method !== 'GET'
        ? JSON.stringify(request.body)
        : undefined;
}

async function toJson(res: Response): Promise<any> {
    return res.json()
        .catch(() => {
            return {};
        });
}

function toStatus(
    config: any,
    result: string,
    actualJson: any,
    res: any,
    interaction: any,
    results: any = {},
): any {
    return {
        name: config.interactionName,
        status: FAILURE,
        result,
        method: interaction.request.method || 'GET',
        path: interaction.request.path,
        timeoutMs: interaction.request.timeoutMs,
        attemptNumber: res.blackBoxAttemptNumber,
        maxAttempts: res.blackBoxMaxAttempts,
        scenarioExecutionNumber: config.interaction.request.scenarioExecutionNumber,
        interactionExecutionNumber: config.interaction.request.interactionExecutionNumber,
        repeatIndex: config.interaction.request.repeatIndex,
        expected: interaction.response,
        actual: {
            body: actualJson,
            statusCode: res.status,
            statusText: res.statusText,
        },
        details: results,
        ...config,
    };
}

function toSuccessStatus(config: any, actualJson: any, response: any, interaction: any): any {
    return {
        name: config.interactionName,
        status: SUCCESS,
        method: interaction.request.method,
        path: interaction.request.path,
        timeoutMs: interaction.request.timeoutMs,
        attemptNumber: response.blackBoxAttemptNumber,
        maxAttempts: response.blackBoxMaxAttempts,
        scenarioExecutionNumber: config.interaction.request.scenarioExecutionNumber,
        interactionExecutionNumber: config.interaction.request.interactionExecutionNumber,
        repeatIndex: config.interaction.request.repeatIndex,
        expected: interaction.response,
        actual: {
            body: actualJson,
            statusCode: response.status,
            statusText: response.statusText,
        },
        output: interaction.request.output,
        input: interaction.request.input,
    };
}

function toHttpInteractionStatus(config: any, interaction: any, response: any, actualJson: any): any {
    if (!response.ok) {
        return toStatus(config, 'Server request failed.', actualJson, response, interaction);
    }

    if (interaction?.response?.body !== undefined) {
        if (actualJson === undefined || actualJson === null) {
            return toStatus(config, 'Server with no body in response. Expects a body.', actualJson, response, interaction);
        }

        const results = compareJson(
            interaction.response.body,
            actualJson,
            toConfig(
                interaction.response?.comparison || COMPARISON.COMPATIBLE,
                interaction.response?.ignoreJsonKeys || [],
                interaction.response?.ignoreJsonPaths || [],
            ),
        );

        if (!results.isEqual) {
            return toStatus(config, 'Expected response not the same as actual response', actualJson, response, interaction, results);
        }
    }

    if (interaction?.response?.statusCode !== undefined && Number.parseInt(interaction.response.statusCode) !== response.status) {
        return toStatus(config, 'Expected responseCode not the same as actual responseCode', actualJson, response, interaction);
    }

    return toSuccessStatus(config, actualJson, response, interaction);
}

function toInteractionName(interactionWithConfig: any): string {
    return Object.keys(interactionWithConfig)
        .filter(key => !['HTTP', 'MQ', 'WS', 'RTC', 'WEBRTC', 'ASSERT', 'SET'].includes(key))[0];
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
        || interaction?.ASSERT
        || interaction?.SET;
}

function toSetSuccessStatus(config: any, interaction: any, value: any): any {
    return {
        name: config.interactionName,
        status: SUCCESS,
        transport: 'SET',
        scenarioExecutionNumber: config.interaction.request.scenarioExecutionNumber,
        interactionExecutionNumber: config.interaction.request.interactionExecutionNumber,
        repeatIndex: config.interaction.request.repeatIndex,
        expected: interaction.response,
        actual: value,
        output: interaction.request.output,
        input: interaction.request.input,
    };
}

function toSetFailureStatus(config: any, interaction: any, result: string, details: any = {}): any {
    return {
        name: config.interactionName,
        status: FAILURE,
        transport: 'SET',
        result,
        scenarioExecutionNumber: config.interaction.request.scenarioExecutionNumber,
        interactionExecutionNumber: config.interaction.request.interactionExecutionNumber,
        repeatIndex: config.interaction.request.repeatIndex,
        expected: interaction.response,
        actual: undefined,
        details,
        ...config,
    };
}

function executeSetInteraction(interaction: any, config: any): Promise<any> {
    const output = interaction.request.output;
    const value = interaction.request.value !== undefined
        ? interaction.request.value
        : interaction.response.actual;

    if (!output) {
        return Promise.resolve(toSetFailureStatus(
            config,
            interaction,
            'Set step is missing output. Use output to name the stored value.',
        ));
    }

    if (value === undefined) {
        return Promise.resolve(toSetFailureStatus(
            config,
            interaction,
            'Set step is missing value. Use value or request.value.',
        ));
    }

    return Promise.resolve(toSetSuccessStatus(config, interaction, value));
}

function toAssertSuccessStatus(config: any, interaction: any, actual: any, details: any = {}): any {
    return {
        name: config.interactionName,
        status: SUCCESS,
        transport: 'ASSERT',
        scenarioExecutionNumber: config.interaction.request.scenarioExecutionNumber,
        interactionExecutionNumber: config.interaction.request.interactionExecutionNumber,
        repeatIndex: config.interaction.request.repeatIndex,
        expected: interaction.response,
        actual,
        details,
        output: interaction.request.output,
        input: interaction.request.input,
    };
}

function toAssertFailureStatus(config: any, interaction: any, actual: any, result: string, details: any = {}): any {
    return {
        name: config.interactionName,
        status: FAILURE,
        transport: 'ASSERT',
        result,
        scenarioExecutionNumber: config.interaction.request.scenarioExecutionNumber,
        interactionExecutionNumber: config.interaction.request.interactionExecutionNumber,
        repeatIndex: config.interaction.request.repeatIndex,
        expected: interaction.response,
        actual,
        details,
        ...config,
    };
}

function executeAssertInteraction(interaction: any, config: any, _context: any): Promise<any> {
    const expected = interaction.response.body !== undefined
        ? interaction.response.body
        : interaction.response.expect !== undefined
            ? interaction.response.expect
            : interaction.response.expected;

    const actual = interaction.response.actual !== undefined
        ? interaction.response.actual
        : interaction.request.actual;

    if (expected === undefined) {
        return Promise.resolve(toAssertFailureStatus(
            config,
            interaction,
            actual,
            'Assert step is missing expected value. Use expect.body, expect.expect, or expect.expected.',
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
        return toHttpInteractionStatus(
            config,
            interaction,
            response,
            parseRemoteHttpBody(response.body),
        );
    } catch (e) {
        const error = e instanceof Error ? e : new Error(String(e));
        return {
            name: config.interactionName,
            exception: error.name === 'AbortError'
                ? 'Remote request timed out after ' + interaction.request.timeoutMs + ' ms'
                : error.message,
            status: FAILURE,
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

function toWsConnectionName(request: any): string {
    return request.connection || request.name || 'default';
}

function toWsExpectedConnectionName(interaction: any): string {
    return interaction.response?.connection
        || interaction.response?.onConnection
        || interaction.request?.expectConnection
        || toWsConnectionName(interaction.request);
}

function toWsComparisonConfig(interaction: any): any {
    return toConfig(
        interaction.response?.comparison || COMPARISON.COMPATIBLE,
        interaction.response?.ignoreJsonKeys || [],
        interaction.response?.ignoreJsonPaths || [],
    );
}

function findWsMessageIndex(
    messages: any[],
    expectedMessage: any,
    interaction: any,
    excludedIndexes: number[] = [],
): number {
    return messages.findIndex((message, index) => {
        if (excludedIndexes.includes(index)) {
            return false;
        }

        const result = compareJson(
            expectedMessage,
            message.data,
            toWsComparisonConfig(interaction),
        );

        return result.isEqual;
    });
}

function findWsMessageIndexFrom(
    messages: any[],
    expectedMessage: any,
    interaction: any,
    fromIndex = 0,
    excludedIndexes: number[] = [],
): number {
    for (let index = fromIndex; index < messages.length; index++) {
        if (excludedIndexes.includes(index)) {
            continue;
        }

        const result = compareJson(
            expectedMessage,
            messages[index].data,
            toWsComparisonConfig(interaction),
        );

        if (result.isEqual) {
            return index;
        }
    }

    return -1;
}

function toWsUrl(request: any): string | undefined {
    return request.url || request.path;
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

function findWsCloseEventIndex(closeEvents: any[], expectedCloseEvent: any, interaction: any): number {
    return closeEvents.findIndex(closeEvent => {
        const result = compareJson(
            expectedCloseEvent,
            closeEvent,
            toConfig(
                interaction.response?.comparison || COMPARISON.COMPATIBLE,
                interaction.response?.ignoreJsonKeys || [],
                interaction.response?.ignoreJsonPaths || [],
            ),
        );

        return result.isEqual;
    });
}

function toWsSuccessStatus(config: any, interaction: any, details: any = {}): any {
    return {
        name: config.interactionName,
        status: SUCCESS,
        transport: 'WS',
        action: interaction.request.action,
        connection: interaction.request.connection || interaction.response?.connection,
        path: interaction.request.path,
        timeoutMs: interaction.request.timeoutMs,
        scenarioExecutionNumber: config.interaction.request.scenarioExecutionNumber,
        interactionExecutionNumber: config.interaction.request.interactionExecutionNumber,
        repeatIndex: config.interaction.request.repeatIndex,
        expected: interaction.response,
        actual: details,
        output: interaction.request.output,
        input: interaction.request.input,
    };
}

function toWsFailureStatus(config: any, interaction: any, result: string, details: any = {}): any {
    return {
        name: config.interactionName,
        status: FAILURE,
        result,
        transport: 'WS',
        action: interaction.request.action,
        connection: interaction.request.connection || interaction.response?.connection,
        path: interaction.request.path,
        timeoutMs: interaction.request.timeoutMs,
        scenarioExecutionNumber: config.interaction.request.scenarioExecutionNumber,
        interactionExecutionNumber: config.interaction.request.interactionExecutionNumber,
        repeatIndex: config.interaction.request.repeatIndex,
        expected: interaction.response,
        actual: details,
        ...config,
    };
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

    ws.send(wirePayload);

    if (interaction.response?.messages) {
        return waitForWsMessages(interaction, config, context, {
            sentConnection: connectionName,
            sent: payload,
        });
    }

    if (interaction.response?.message) {
        return waitForWsMessage(interaction, config, context, {
            sentConnection: connectionName,
            sent: payload,
        });
    }

    return Promise.resolve(toWsSuccessStatus(config, interaction, {
        connection: connectionName,
        sent: payload,
    }));
}

function waitForWsMessage(interaction: any, config: any, context: any, details: any = {}): Promise<any> {
    const request = interaction.request;
    const connectionName = toWsExpectedConnectionName(interaction);
    const expectedMessage = interaction.response.message;
    const timeoutMs = Number.parseInt(interaction.response.withinMs || request.timeoutMs || 5000);
    const startedAt = Date.now();
    const consume = interaction.response.consume === true;

    return new Promise(resolve => {
        const interval = setInterval(() => {
            const messages = context.wsMessages[connectionName] || [];
            const matchIndex = findWsMessageIndex(messages, expectedMessage, interaction);

            if (matchIndex >= 0) {
                clearInterval(interval);
                const match = messages[matchIndex];

                if (consume) {
                    messages.splice(matchIndex, 1);
                }

                resolve(toWsSuccessStatus(config, interaction, {
                    ...details,
                    connection: connectionName,
                    matchedMessage: match,
                    consumed: consume,
                    waitedMs: Date.now() - startedAt,
                }));
                return;
            }

            if (Date.now() - startedAt >= timeoutMs) {
                clearInterval(interval);
                resolve(toWsFailureStatus(config, interaction, 'Expected WebSocket message was not received', {
                    ...details,
                    connection: connectionName,
                    expectedMessage,
                    messages,
                    waitedMs: Date.now() - startedAt,
                }));
            }
        }, 25);
    });
}

function waitForWsMessages(interaction: any, config: any, context: any, details: any = {}): Promise<any> {
    const request = interaction.request;
    const connectionName = toWsExpectedConnectionName(interaction);
    const expectedMessages = interaction.response.messages;
    const timeoutMs = Number.parseInt(interaction.response.withinMs || request.timeoutMs || 5000);
    const startedAt = Date.now();
    const consume = interaction.response.consume === true;
    const ordered = interaction.response.ordered === true;

    if (!Array.isArray(expectedMessages) || expectedMessages.length <= 0) {
        return Promise.resolve(toWsFailureStatus(config, interaction, 'Expected WebSocket messages must be a non-empty array', {
            ...details,
            connection: connectionName,
            expectedMessages,
        }));
    }

    return new Promise(resolve => {
        const interval = setInterval(() => {
            const messages = context.wsMessages[connectionName] || [];
            const matchedMessages: any[] = [];
            const matchedIndexes: number[] = [];

            let nextOrderedSearchIndex = 0;

            for (const expectedMessage of expectedMessages) {
                const matchIndex = ordered
                    ? findWsMessageIndexFrom(messages, expectedMessage, interaction, nextOrderedSearchIndex, matchedIndexes)
                    : findWsMessageIndex(messages, expectedMessage, interaction, matchedIndexes);

                if (matchIndex >= 0) {
                    matchedIndexes.push(matchIndex);
                    matchedMessages.push({
                        expectedMessage,
                        matchedMessage: messages[matchIndex],
                    });

                    if (ordered) {
                        nextOrderedSearchIndex = matchIndex + 1;
                    }
                } else if (ordered) {
                    break;
                }
            }

            if (matchedMessages.length === expectedMessages.length) {
                clearInterval(interval);

                if (consume) {
                    matchedIndexes
                        .sort((a, b) => b - a)
                        .forEach(index => messages.splice(index, 1));
                }

                resolve(toWsSuccessStatus(config, interaction, {
                    ...details,
                    connection: connectionName,
                    matchedMessages,
                    consumed: consume,
                    ordered,
                    waitedMs: Date.now() - startedAt,
                }));
                return;
            }

            if (Date.now() - startedAt >= timeoutMs) {
                clearInterval(interval);
                resolve(toWsFailureStatus(config, interaction, ordered
                    ? 'Expected WebSocket messages were not received in the expected order'
                    : 'Expected WebSocket messages were not received', {
                    ...details,
                    connection: connectionName,
                    expectedMessages,
                    matchedMessages,
                    missingMessages: expectedMessages.filter((expectedMessage: any) => {
                        return matchedMessages.every(match => match.expectedMessage !== expectedMessage);
                    }),
                    ordered,
                    messages,
                    waitedMs: Date.now() - startedAt,
                }));
            }
        }, 25);
    });
}

function waitForWsClose(interaction: any, config: any, context: any, details: any = {}): Promise<any> {
    const request = interaction.request;
    const connectionName = toWsExpectedConnectionName(interaction);
    const expectedClose = interaction.response.close === true
        ? {}
        : interaction.response.close;
    const timeoutMs = Number.parseInt(interaction.response.withinMs || request.timeoutMs || 5000);
    const startedAt = Date.now();
    const consume = interaction.response.consume === true;

    if (expectedClose === undefined) {
        return Promise.resolve(toWsFailureStatus(config, interaction, 'WebSocket close expectation is missing. Use expect.close.', {
            ...details,
            connection: connectionName,
        }));
    }

    return new Promise(resolve => {
        const interval = setInterval(() => {
            const closeEvents = context.wsCloseEvents[connectionName] || [];
            const matchIndex = findWsCloseEventIndex(closeEvents, expectedClose, interaction);

            if (matchIndex >= 0) {
                clearInterval(interval);
                const match = closeEvents[matchIndex];

                if (consume) {
                    closeEvents.splice(matchIndex, 1);
                }

                resolve(toWsSuccessStatus(config, interaction, {
                    ...details,
                    connection: connectionName,
                    matchedCloseEvent: match,
                    consumed: consume,
                    waitedMs: Date.now() - startedAt,
                }));
                return;
            }

            if (Date.now() - startedAt >= timeoutMs) {
                clearInterval(interval);
                resolve(toWsFailureStatus(config, interaction, 'Expected WebSocket close event was not received', {
                    ...details,
                    connection: connectionName,
                    expectedClose,
                    closeEvents,
                    waitedMs: Date.now() - startedAt,
                }));
            }
        }, 25);
    });
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

    try {
        const command = toRemoteWsSendCommand(commandId, interaction, context);
        const result = await executeRallarRemoteBrowserCommand(remote, fetchFn, context, command);
        if (!result.ok) {
            return toRemoteWsFailure(config, interaction, 'Remote WebSocket send failed', {
                connection: connectionName,
                remote,
                result,
            });
        }

        const details = {
            sentConnection: connectionName,
            sent: toRemoteWsPayload(interaction.request),
            remote,
            commandId,
            result: remoteResultValue(result),
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
            sent: toRemoteWsPayload(interaction.request),
            remote,
            commandId,
            result: remoteResultValue(result),
        });
    } catch (error) {
        return toRemoteWsFailure(config, interaction, 'Remote WebSocket send failed', {
            connection: connectionName,
            remote,
            exception: error instanceof Error ? error.message : String(error),
        });
    }
}

async function waitRemoteWs(interaction: any, config: any, context: any): Promise<any> {
    const remote = toRemoteWsConfig(interaction, config, context);
    const fetchFn = remoteBrowserFetch(context);
    return waitWithRemoteWsEventSync(remote, fetchFn, context, () => {
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
            'WebSocket wait expects expect.message, expect.messages, or expect.close',
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

    if (action === 'connect') {
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

    if (action === 'connect') {
        return openWs(interaction, config, context);
    }

    if (action === 'send') {
        return sendWs(interaction, config, context);
    }

    if (action === 'wait' || action === 'expect') {
        if (interaction.response?.close !== undefined) {
            return waitForWsClose(interaction, config, context);
        }

        if (interaction.response?.messages) {
            return waitForWsMessages(interaction, config, context);
        }

        if (interaction.response?.message) {
            return waitForWsMessage(interaction, config, context);
        }

        return Promise.resolve(toWsFailureStatus(config, interaction, 'WebSocket wait expects expect.message, expect.messages, or expect.close'));
    }

    if (action === 'close') {
        return closeWs(interaction, config, context);
    }

    return Promise.resolve(toWsFailureStatus(config, interaction, 'Unsupported WebSocket action: ' + action));
}

function toRequest(request: any, context: any): any {
    return resolvePlaceholders(request, context);
}

function toOutputKey(interactionData: any): string {
    return interactionData.scenarioExecutionNumber + '-' + interactionData.name + '-' + interactionData.interactionExecutionNumber;
}

function toResultEntries(results: any): any[] {
    return Object.values(results || {});
}

function toSummary(results: any, options: any, startedAtEpochMs: number, endedAtEpochMs: number): any {
    const entries = toResultEntries(results);
    const failures = entries.filter(entry => entry?.status === FAILURE);
    const successes = entries.filter(entry => entry?.status === SUCCESS);

    return {
        total: entries.length,
        success: successes.length,
        failure: failures.length,
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
    return {
        summary: toSummary(context.results, options, startedAtEpochMs, endedAtEpochMs),
        results: context.results,
        resultsList: context.resultsList,
        resultsByName: context.resultsByName,
        outputs: context.outputs,
        wsMessages: context.wsMessages,
        wsCloseEvents: context.wsCloseEvents,
        rtcConnections: context.rtcConnections,
        rtcMessages: context.rtcMessages,
        rtcCloseEvents: context.rtcCloseEvents,
        rtcProviderNames: Object.keys(context.rtcProviders || {}),
    };
}

function fetchDataBasic(request: any): Promise<Response> {
    const controller = request.timeoutMs
        ? new AbortController()
        : undefined;

    const timeout = request.timeoutMs
        ? setTimeout(() => controller?.abort(), Number.parseInt(request.timeoutMs))
        : undefined;

    return fetch(
        request.path,
        {
            method: request.method,
            credentials: request.credentials ? request.credentials : 'omit',
            mode: request.mode ? request.mode : 'cors',
            headers: request.headers,
            body: toBody(request),
            signal: controller?.signal,
        },
    ).finally(() => {
        if (timeout) {
            clearTimeout(timeout);
        }
    });
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

function executeRtcInteraction(interaction: any, config: any, context: any): Promise<any> {
    const action = interaction.request.action || 'send';
    const providerName = interaction.request.provider || 'rallar';
    const provider = context.rtcProviders?.[providerName] || createMissingRtcProvider(providerName);

    if (isDryRunExecution(interaction, config, context)) {
        return Promise.resolve(toRtcSuccessStatus(config, interaction, {
            dryRun: true,
            normalized: {
                ...interaction.request,
                response: interaction.response,
            },
        }))
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

function executeInteraction(interactionWithConfig: any, context: any): Promise<any> {
    const interaction = toExecutableInteraction(interactionWithConfig);

    if (!interaction) {
        return Promise.resolve();
    }

    interaction.request = toRequest(interaction.request, context);
    interaction.response = resolvePlaceholders(interaction.response || {}, context);

    const config = {
        interactionName: toInteractionName(interactionWithConfig),
        interactionConfig: toInteractionConfig(interactionWithConfig),
        interaction,
    };

    if (interactionWithConfig.ASSERT) {
        return executeAssertInteraction(interaction, config, context);
    }

    if (interactionWithConfig.SET) {
        return executeSetInteraction(interaction, config);
    }

    if (interactionWithConfig.WS) {
        return executeWsInteraction(interaction, config, context);
    }

    if (interactionWithConfig.RTC || interactionWithConfig.WEBRTC) {
        return executeRtcInteraction(interaction, config, context);
    }

    if (isRallarRemoteBrowserRequest(interaction.request)) {
        return executeRemoteHttpInteraction(interaction, config, context);
    }

    return fetchWithRetry(interaction.request)
        .then(async response => {
            const actualJson = await toJson(response);
            return toHttpInteractionStatus(config, interaction, response, actualJson);
        })
        .catch(e => {
            return {
                name: config.interactionName,
                exception: e?.name === 'AbortError'
                    ? 'Request timed out after ' + interaction.request.timeoutMs + ' ms'
                    : e?.message,
                status: FAILURE,
                method: interaction.request.method || 'GET',
                path: interaction.request.path,
                timeoutMs: interaction.request.timeoutMs,
                attemptNumber: e.blackBoxAttemptNumber,
                maxAttempts: e.blackBoxMaxAttempts,
                scenarioExecutionNumber: config.interaction.request.scenarioExecutionNumber,
                interactionExecutionNumber: config.interaction.request.interactionExecutionNumber,
                repeatIndex: config.interaction.request.repeatIndex,
                ...config,
            };
        });
}

function executeBlackBoxRecursive(
    interactions: any[],
    index: number,
    options: any = {},
    context: any,
): Promise<any> {
    const executeNext = (interactionData: any): any => {
        storeInteractionData(interactionData, context);

        const data = {
            [toResultKey(interactionData)]: interactionData,
        };

        if (interactionData.status === FAILURE && options.failFast !== false) {
            return data;
        }

        if (index + 1 < interactions.length) {
            return executeBlackBoxRecursive(interactions, ++index, options, context)
                .then(d => {
                    return { ...data, ...d };
                })
                .catch(e => {
                    return { ...data, ...e };
                });
        }

        return data;
    };

    const startedAtEpochMs = Date.now();

    return executeInteraction(interactions[index], context)
        .then(data => {
            const endedAtEpochMs = Date.now();
            return executeNext({
                ...data,
                startedAtEpochMs,
                endedAtEpochMs,
                durationMs: endedAtEpochMs - startedAtEpochMs,
            });
        })
        .catch(e => {
            const endedAtEpochMs = Date.now();
            return executeNext({
                ...e,
                startedAtEpochMs,
                endedAtEpochMs,
                durationMs: endedAtEpochMs - startedAtEpochMs,
            });
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
