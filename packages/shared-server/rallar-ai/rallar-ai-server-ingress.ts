import { RallarAiError, type RallarAiJsonResult, type RallarAiJsonValue } from '@shared/rallar-ai/mod.ts';
import { createRallarServerAiTopicInstaller } from './create-rallar-server-ai-topic-installer.ts';
import { DEFAULT_AI_REST_PATH } from './rallar-ai-server-config.ts';
import { isRallarAiJsonRequest } from './rallar-ai-server-generation.ts';
import type {
    CreateRallarServerAiOptions,
    RallarServerAiFacade,
    RallarServerAiRestGenerateInput,
    RallarServerAiRestGenerateResponse,
    RallarServerAiRestPostApp,
    RallarServerAiRestRouteOptions
} from './rallar-ai-server.ts';
import type { RallarServerAiBoundaryValue } from './rallar-server-ai-boundary-value.ts';

interface CreateRallarServerAiIngressInput {
    readonly options: CreateRallarServerAiOptions;
    readonly generateJson: RallarServerAiFacade['generateJson'];
    readonly maxRequestBytes: number;
}

export interface RallarServerAiIngress {
    readonly handleRestGenerateJson: RallarServerAiFacade['handleRestGenerateJson'];
    readonly createRestRouteInstaller: RallarServerAiFacade['createRestRouteInstaller'];
    readonly installGenerationTopic: RallarServerAiFacade['installGenerationTopic'];
}

export function createRallarServerAiIngress(
    input: CreateRallarServerAiIngressInput
): RallarServerAiIngress {
    const handleRestGenerateJson: RallarServerAiFacade['handleRestGenerateJson'] = async <
        TValue extends RallarAiJsonValue = RallarAiJsonValue,
    >(
        restInput: RallarServerAiRestGenerateInput
    ): Promise<RallarServerAiRestGenerateResponse<TValue>> => {
        if (!isRallarAiJsonRequest(restInput.body)) {
            return toRestError(
                new RallarAiError(
                    'invalid-json',
                    'RallarAI REST generation body must be a JSON request.'
                )
            );
        }

        try {
            const result = await input.generateJson<TValue>(restInput.body, {
                actorId: restInput.actorId,
                roomId: restInput.roomId
            });
            return toRestSuccess(result);
        }
        catch (error) {
            return toRestError(error instanceof Error ? error : new Error(String(error)));
        }
    };

    return {
        handleRestGenerateJson,
        createRestRouteInstaller: (routeOptions = {}) => createRestRouteInstaller(input.generateJson, routeOptions),
        installGenerationTopic: createRallarServerAiTopicInstaller(input)
    };
}

function createRestRouteInstaller(
    generateJson: RallarServerAiFacade['generateJson'],
    routeOptions: RallarServerAiRestRouteOptions
): (app: RallarServerAiRestPostApp) => void {
    return (app) => {
        app.post(
            routeOptions.path ?? DEFAULT_AI_REST_PATH,
            async (request, response) => {
                const restResponse = await handleRestInvocation({
                    request,
                    response,
                    routeOptions,
                    generateJson
                });
                return writeRestResponse(response, restResponse);
            }
        );
    };
}

interface HandleRestInvocationInput {
    readonly request: RallarServerAiBoundaryValue;
    readonly response: RallarServerAiBoundaryValue;
    readonly routeOptions: RallarServerAiRestRouteOptions;
    readonly generateJson: RallarServerAiFacade['generateJson'];
}

async function handleRestInvocation(
    input: HandleRestInvocationInput
): Promise<RallarServerAiRestGenerateResponse> {
    const body = input.routeOptions.readBody
        ? await input.routeOptions.readBody(input.request)
        : await defaultReadBody(input.request);
    if (!isRallarAiJsonRequest(body)) {
        return toRestError(
            new RallarAiError(
                'invalid-json',
                'RallarAI REST generation body must be a JSON request.'
            )
        );
    }

    try {
        const result = await input.generateJson(body, {
            actorId: input.routeOptions.readActorId?.(input.request) ??
                readActorIdFromRequest(input.request, input.response),
            roomId: input.routeOptions.readRoomId?.(input.request) ??
                readRoomIdFromRequest(input.request)
        });
        return toRestSuccess(result);
    }
    catch (error) {
        return toRestError(error instanceof Error ? error : new Error(String(error)));
    }
}

function toRestSuccess<TValue extends RallarAiJsonValue>(
    result: RallarAiJsonResult<TValue>
): RallarServerAiRestGenerateResponse<TValue> {
    return {
        status: 200,
        headers: jsonHeaders(),
        body: { ok: true, result }
    };
}

function toRestError<TValue extends RallarAiJsonValue = RallarAiJsonValue>(
    error: Error
): RallarServerAiRestGenerateResponse<TValue> {
    const aiError = error instanceof RallarAiError
        ? error
        : new RallarAiError('provider-failed', error.message);
    return {
        status: toHttpStatus(aiError.code),
        headers: jsonHeaders(),
        body: {
            ok: false,
            error: { code: aiError.code, message: aiError.message }
        }
    };
}

function toHttpStatus(code: string): number {
    switch (code) {
        case 'invalid-json':
        case 'invalid-configuration':
        case 'provider-target-mismatch':
            return 400;
        case 'unauthorized':
            return 403;
        case 'disabled':
        case 'provider-unavailable':
            return 503;
        case 'request-too-large':
            return 413;
        case 'quota-exceeded':
            return 429;
        case 'schema-validation-failed':
            return 422;
        case 'provider-timeout':
            return 504;
        default:
            return 502;
    }
}

async function defaultReadBody(
    request: RallarServerAiBoundaryValue
): Promise<RallarServerAiBoundaryValue> {
    if (isRecord(request) && 'body' in request) {
        return request.body;
    }
    if (isRecord(request) && typeof request.json === 'function') {
        return await request.json();
    }
    return request;
}

function writeRestResponse(
    response: RallarServerAiBoundaryValue,
    restResponse: RallarServerAiRestGenerateResponse
): RallarServerAiBoundaryValue {
    if (isRecord(response) && typeof response.status === 'function') {
        const statusResult = response.status(restResponse.status);
        if (isRecord(statusResult) && typeof statusResult.json === 'function') {
            return statusResult.json(restResponse.body);
        }
    }
    if (isRecord(response) && typeof response.json === 'function') {
        if (typeof response.statusCode === 'number') {
            response.statusCode = restResponse.status;
        }
        return response.json(restResponse.body);
    }
    if (typeof Response !== 'undefined') {
        return new Response(JSON.stringify(restResponse.body), {
            status: restResponse.status,
            headers: restResponse.headers
        });
    }
    return restResponse;
}

function readActorIdFromRequest(
    request: RallarServerAiBoundaryValue,
    response: RallarServerAiBoundaryValue
): string | undefined {
    return readStringPath(request, ['actorId']) ??
        readStringPath(request, ['user', 'id']) ??
        readStringPath(request, ['auth', 'actorId']) ??
        readStringPath(response, ['locals', 'actorId']) ??
        readStringPath(response, ['locals', 'user', 'id']);
}

function readRoomIdFromRequest(request: RallarServerAiBoundaryValue): string | undefined {
    return readStringPath(request, ['roomId']) ??
        readStringPath(request, ['params', 'roomId']) ??
        readStringPath(request, ['query', 'roomId']);
}

function readStringPath(
    value: RallarServerAiBoundaryValue,
    path: readonly string[]
): string | undefined {
    let current = value;
    for (const segment of path) {
        if (!isRecord(current)) {
            return undefined;
        }
        current = current[segment];
    }
    return typeof current === 'string' ? current : undefined;
}

function jsonHeaders(): Readonly<Record<string, string>> {
    return { 'content-type': 'application/json' };
}

function isRecord(
    value: RallarServerAiBoundaryValue
): value is Record<string, RallarServerAiBoundaryValue> {
    return value !== null && typeof value === 'object';
}
