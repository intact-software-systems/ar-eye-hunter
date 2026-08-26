import { RallarAiError, type RallarAiJsonResult, type RallarAiJsonValue } from '@shared/rallar-ai/mod.ts';
import type { JsonWireValue } from '../rallar-system/protocol/json-wire-identity.ts';
import { decodeRallarServerAiJsonRequest } from './decode-rallar-server-ai-json-request.ts';
import type { RallarServerAi } from './rallar-server-ai-contracts.ts';

export interface RallarServerAiHttpRequest {
    readonly body: JsonWireValue;
    readonly actorId?: string;
    readonly roomId?: string;
}

export interface RallarServerAiHttpResponse<TValue extends RallarAiJsonValue> {
    readonly status: number;
    readonly headers: Readonly<Record<string, string>>;
    readonly body:
        | Readonly<{ ok: true; result: RallarAiJsonResult<TValue>; }>
        | Readonly<{
            ok: false;
            error: Readonly<{ code: string; message: string; }>;
        }>;
}

export type RallarServerAiHttpHandler = (
    request: RallarServerAiHttpRequest
) => Promise<RallarServerAiHttpResponse<RallarAiJsonValue>>;

export interface RallarServerAiHttpRouter {
    post(path: string, handler: RallarServerAiHttpHandler): void;
}

export interface InstallRallarServerAiHttpRouteInput {
    readonly router: RallarServerAiHttpRouter;
    readonly serverAi: RallarServerAi;
    readonly path: string;
}

export function installRallarServerAiHttpRoute(
    input: InstallRallarServerAiHttpRouteInput
): void {
    input.router.post(
        input.path,
        (request) => respondToRallarServerAiHttpRequest(input.serverAi, request)
    );
}

export async function respondToRallarServerAiHttpRequest(
    serverAi: RallarServerAi,
    request: RallarServerAiHttpRequest
): Promise<RallarServerAiHttpResponse<RallarAiJsonValue>> {
    try {
        const generationRequest = decodeRallarServerAiJsonRequest(request.body);
        const result = await serverAi.generateJson(generationRequest, {
            actorId: request.actorId,
            roomId: request.roomId
        });
        return {
            status: 200,
            headers: jsonHeaders(),
            body: { ok: true, result }
        };
    }
    catch (error) {
        const cause = error instanceof Error ? error : new Error(String(error));
        const aiError = cause instanceof RallarAiError
            ? cause
            : new RallarAiError('provider-failed', cause.message);
        return {
            status: toHttpStatus(aiError.code),
            headers: jsonHeaders(),
            body: {
                ok: false,
                error: { code: aiError.code, message: aiError.message }
            }
        };
    }
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

function jsonHeaders(): Readonly<Record<string, string>> {
    return { 'content-type': 'application/json' };
}
