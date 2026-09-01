// deno-lint-ignore-file no-explicit-any
import type { RallarBlackBoxTestCommand } from '../../rallar-bb-test/types.ts';
import { executeHttpInteraction } from '../http/execute-http-interaction.ts';
import { toHttpInteractionStatus, toStatus } from '../http/http-response-expectations.ts';
import { normalizeBlackBoxResponseHeaders } from '../http/normalize-black-box-response-headers.ts';
import {
    executeRallarRemoteBrowserCommand,
    resolveRallarRemoteBrowserConfig,
    toRallarRemoteBrowserCommandId,
    type RallarRemoteBrowserControlResultEnvelope
} from '../rallar-remote-browser-provider.ts';
import { toCorrelationReportFields } from './black-box-run-correlation.ts';
import {
    assertRemoteDestinationAllowed,
    assertRemotePayloadWithinLimit,
    remoteBrowserFetch,
    remoteBrowserOptions,
    remoteResultValue,
    toRemoteHttpBody,
    toRemoteHttpHeaders,
    toRemoteHttpResponseOptions
} from './remote-browser-execution.ts';

const FAILURE = 'FAILURE';

function toRemoteHttpCommand(commandId: string, interaction: any, context: any): RallarBlackBoxTestCommand {
    const request = interaction.request;
    const body = toRemoteHttpBody(request);
    assertRemoteDestinationAllowed({
        request,
        context,
        url: request.url ?? request.path,
        label: 'HTTP'
    });
    assertRemotePayloadWithinLimit({
        request,
        context,
        value: body,
        label: 'HTTP request'
    });
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
            mode: request.mode
        },
        response: toRemoteHttpResponseOptions(request),
        timeoutMs: request.timeoutMs,
        metadata: {
            blackBoxRunner: request
        }
    };
}

function parseRemoteHttpBody(body: any): any {
    if (typeof body !== 'string') {
        return body;
    }

    try {
        return JSON.parse(body);
    }
    catch (_ignored) {
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
        blackBoxMaxAttempts: 1
    };
}

function withRemoteHttpDetails(status: any, details: any): any {
    return {
        ...status,
        actual: {
            ...status.actual,
            ...details
        }
    };
}

export async function executeRemoteHttpInteraction(interaction: any, config: any, context: any): Promise<any> {
    const remote = resolveRallarRemoteBrowserConfig(
        interaction.request,
        config,
        context,
        remoteBrowserOptions(context)
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
                    blackBoxMaxAttempts: 1
                },
                interaction,
                {
                    remote,
                    result
                }
            );
        }

        const response = toRemoteHttpResponse(result);
        return withRemoteHttpDetails(
            toHttpInteractionStatus(
                config,
                interaction,
                response,
                parseRemoteHttpBody(response.body)
            ),
            {
                remote,
                commandId,
                result: remoteResultValue(result)
            }
        );
    }
    catch (e) {
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
                remote
            },
            ...config
        };
    }
}
