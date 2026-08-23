import { verifyRallarBlackBoxOperatorToken } from '@shared-server/http/black-box-operator-token.ts';
import type { RallarBlackBoxTestCommand } from '@shared-test/rallar-bb-test/types.ts';

import { createControlRequestBodyReader, type ControlJsonValue } from './control-request-body.ts';
import type { BlackBoxControlServerConfiguration } from './control-server-configuration.ts';
import type { RallarBlackBoxControlService } from './control-service.ts';
import { validateBrowserCommandDestination } from './validate-browser-command-destination.ts';

export interface ControlHttpSecurity {
    rejectByRequestPolicy(request: Request, url: URL): Response | undefined;
    isProtectedControlReadPath(pathname: string): boolean;
    authorizeReadRequest(request: Request, url: URL): Promise<boolean>;
    authorizeAdminRequest(request: Request, url: URL): Promise<boolean>;
    authorizeRunRequest(request: Request, url: URL, runId: string, agentId: string): boolean;
    authorizeRunToken(runId: string, agentId: string, token: string | undefined): boolean;
    tokenFromRequest(request: Request, url: URL): string | undefined;
    assertPayloadByteLength(byteLength: number): void;
    readJsonBody(request: Request, allowEmpty?: boolean): Promise<ControlJsonValue>;
    validateBrowserCommandDestination(command: RallarBlackBoxTestCommand): string | undefined;
}

export interface CreateControlHttpSecurityInput {
    readonly configuration: BlackBoxControlServerConfiguration;
    readonly controlService: RallarBlackBoxControlService;
    readonly jsonResponse: (value: object, status?: number) => Response;
}

export function createControlHttpSecurity(
    input: CreateControlHttpSecurityInput
): ControlHttpSecurity {
    const { configuration, controlService, jsonResponse } = input;
    const requestBodyReader = createControlRequestBodyReader(configuration.maxRequestBytes);

    async function authorizeAdminRequest(request: Request, url: URL): Promise<boolean> {
        if (!configuration.adminToken && !configuration.operatorTokenSecret) {
            return true;
        }

        const token = tokenFromRequest(request, url);
        if (configuration.adminToken && token === configuration.adminToken) {
            return true;
        }

        if (!configuration.operatorTokenSecret) {
            return false;
        }

        const verified = await verifyRallarBlackBoxOperatorToken({
            token,
            secret: configuration.operatorTokenSecret
        });
        return verified.ok;
    }

    function authorizeRunToken(
        runId: string,
        agentId: string,
        token: string | undefined
    ): boolean {
        const tokenRequired = configuration.requireRunToken ||
            controlService.hasActiveRunToken(runId, agentId);
        if (!tokenRequired) {
            return true;
        }

        return controlService.validateRunToken(runId, agentId, token);
    }

    return {
        rejectByRequestPolicy(request, url) {
            if (
                configuration.requireTls &&
                url.protocol !== 'https:' &&
                request.headers.get('x-forwarded-proto') !== 'https'
            ) {
                return jsonResponse({ error: 'TLS is required.' }, 400);
            }

            const origin = request.headers.get('origin');
            if (
                origin &&
                configuration.allowedOrigins.length > 0 &&
                !configuration.allowedOrigins.includes(origin)
            ) {
                return jsonResponse({ error: 'Origin is not allowed.' }, 403);
            }

            return undefined;
        },
        isProtectedControlReadPath(pathname) {
            return pathname === '/runs' ||
                pathname.startsWith('/runs/') ||
                pathname === '/distributed-runs' ||
                pathname.startsWith('/distributed-runs/') ||
                pathname === '/fleet/reports' ||
                pathname.startsWith('/fleet/reports/');
        },
        async authorizeReadRequest(request, url) {
            if (!configuration.requireReadToken) {
                return true;
            }

            if (!configuration.adminToken && !configuration.operatorTokenSecret) {
                return false;
            }

            return await authorizeAdminRequest(request, url);
        },
        authorizeAdminRequest,
        authorizeRunRequest(request, url, runId, agentId) {
            return authorizeRunToken(runId, agentId, tokenFromRequest(request, url));
        },
        authorizeRunToken,
        tokenFromRequest,
        assertPayloadByteLength: requestBodyReader.assertPayloadByteLength,
        readJsonBody: requestBodyReader.readJsonBody,
        validateBrowserCommandDestination(command) {
            return validateBrowserCommandDestination(command, configuration);
        }
    };
}

function tokenFromRequest(request: Request, url: URL): string | undefined {
    const authorization = request.headers.get('authorization');
    if (authorization?.toLowerCase().startsWith('bearer ')) {
        return authorization.slice('bearer '.length).trim();
    }

    return request.headers.get('x-rallar-run-token')?.trim() ||
        url.searchParams.get('token')?.trim() ||
        undefined;
}
