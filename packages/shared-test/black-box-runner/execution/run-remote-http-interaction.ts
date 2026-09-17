// deno-lint-ignore-file no-explicit-any
import type {
    ApiJsonObject,
    ApiJsonValue
} from '../../../shared/api/api-json-value.ts';
import { Either } from '../../../shared/resilience/Either.ts';
import { toError } from '../../../shared/resilience/to-error.ts';

import type { ControlResultEnvelope } from '../../rallar-bb-test/control-protocol.ts';
import type { RallarBlackBoxTestHttpRequestCommand } from '../../rallar-bb-test/rallar-black-box-test-contracts.ts';
import { isJsonRecordValue } from '../../rallar-bb-test/schema/json-schema-validation.ts';
import {
    toHttpInteractionStatus,
    toStatus
} from '../http/http-response-expectations.ts';
import {
    runRallarRemoteBrowserCommand,
    toRemoteResultValue
} from '../remote-browser/rallar-remote-browser-control-client.ts';
import { toRallarRemoteBrowserCommandId } from '../remote-browser/remote-browser-commands.ts';
import {
    resolveRallarRemoteBrowserConfig,
    type RallarRemoteBrowserConfig
} from '../remote-browser/resolve-rallar-remote-browser-config.ts';
import { toCorrelationReportFields } from './black-box-run-correlation.ts';
import type { BlackBoxFetch } from './black-box-scenario-context.ts';
import {
    toRemoteHttpBody,
    toRemoteHttpHeaders,
    toRemoteHttpResponseOptions,
    validateRemoteDestination,
    validateRemotePayloadSize
} from './remote-browser-execution.ts';

interface RemoteHttpRequestInput {
    readonly interaction: any;
    readonly config: any;
    readonly context: any;
    readonly remote: RallarRemoteBrowserConfig;
    readonly fetch: BlackBoxFetch;
    readonly commandId: string;
}

interface RemoteHttpResultInput extends RemoteHttpRequestInput {
    readonly result: ControlResultEnvelope;
}

interface RemoteHttpExceptionInput {
    readonly interaction: any;
    readonly config: any;
    readonly remote: RallarRemoteBrowserConfig;
    readonly error: Error;
}

const FAILURE = 'FAILURE';

export function runRemoteHttpInteraction(interaction: any, config: any, context: any): Promise<any> {
    const remote = resolveRallarRemoteBrowserConfig({ request: interaction.request, config, context });
    const fetch = context.dependencies.fetch;
    return toRallarRemoteBrowserCommandId('http', interaction).fold(
        (error) => Promise.resolve(toRemoteHttpException({ interaction, config, remote, error })),
        (commandId) => sendRemoteHttpRequest({ interaction, config, context, remote, fetch, commandId })
    );
}

async function sendRemoteHttpRequest(input: RemoteHttpRequestInput): Promise<any> {
    const { interaction, config, context, remote, fetch, commandId } = input;
    const ran = await toRemoteHttpCommand(commandId, interaction, context).fold(
        (error) => Promise.resolve(Either.ofLeft<Error, ControlResultEnvelope>(error)),
        (command) => runRallarRemoteBrowserCommand({ remote, fetch, context, command })
    );
    try {
        return ran.fold(
            (error) => toRemoteHttpException({ interaction, config, remote, error }),
            (result) => toRemoteHttpStatus({ ...input, result })
        );
    }
    catch (caught) {
        // A response the step's expectations cannot evaluate, such as an unsupported comparison, fails the step.
        return toRemoteHttpException({ interaction, config, remote, error: toError(caught) });
    }
}

function toRemoteHttpCommand(
    commandId: string,
    interaction: any,
    context: any
): Either<Error, RallarBlackBoxTestHttpRequestCommand> {
    const request = interaction.request;
    const body = toRemoteHttpBody(request);
    const [issue] = [
        ...validateRemoteDestination({ request, context, url: request.url ?? request.path, label: 'HTTP' }),
        ...validateRemotePayloadSize({ request, context, value: body, label: 'HTTP request' })
    ];
    if (issue !== undefined) {
        return Either.ofLeft(new Error(issue));
    }
    return Either.ofRight({
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
    });
}

function toRemoteHttpStatus(input: RemoteHttpResultInput): any {
    const { interaction, config, remote, commandId, result } = input;
    const value = toRemoteResultValue(result);
    if (!result.ok) {
        return toStatus({
            config,
            result: 'Remote HTTP request failed',
            actualJson: value,
            response: {
                status: 0,
                statusText: 'Remote command failed',
                blackBoxAttemptNumber: 1,
                blackBoxMaxAttempts: 1
            },
            interaction,
            details: {
                remote,
                result
            }
        });
    }
    const response = toRemoteHttpResponse(value);
    const status = toHttpInteractionStatus({
        config,
        interaction,
        response,
        actualJson: toRemoteHttpJson(response.body)
    });
    return {
        ...status,
        actual: {
            ...status.actual,
            remote,
            commandId,
            result: value
        }
    };
}

/** A value that is not a JSON object reads as a response with none of its members. */
function toRemoteHttpResponse(value: ApiJsonValue): any {
    const response: ApiJsonObject = isJsonRecordValue(value) ? value : {};
    const status = Number.parseInt(String(response.status ?? 0), 10);
    return {
        status,
        statusText: response.statusText ?? '',
        ok: typeof response.ok === 'boolean'
            ? response.ok
            : status >= 200 && status < 300,
        headers: response.headers ?? {},
        url: response.url,
        body: response.body,
        blackBoxAttemptNumber: 1,
        blackBoxMaxAttempts: 1
    };
}

/** A text body is read as JSON when it parses, and as an empty object when it does not. */
function toRemoteHttpJson(body: any): any {
    if (typeof body !== 'string') {
        return body;
    }

    try {
        return JSON.parse(body);
    }
    catch {
        return {};
    }
}

function toRemoteHttpException(input: RemoteHttpExceptionInput): any {
    const { interaction, config, remote, error } = input;
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
