import { verifyRallarBlackBoxOperatorToken } from '@shared-server/http/black-box-operator-token.ts';

import type { BlackBoxControlServerConfiguration } from '../control-server-configuration.ts';
import type { RallarBlackBoxControlService } from '../control-service.ts';
import type { ControlHttpRejection } from './control-http-responses.ts';

export type ControlHttpAccessConfiguration = Pick<
    BlackBoxControlServerConfiguration,
    'adminToken' | 'allowedOrigins' | 'operatorTokenSecret' | 'requireReadToken' | 'requireRunToken' | 'requireTls'
>;

export interface ControlHttpSecurityDependencies {
    readonly configuration: ControlHttpAccessConfiguration;
    readonly controlService: Pick<RallarBlackBoxControlService, 'hasActiveRunToken' | 'validateRunToken'>;
}

export interface ControlRunTokenPresentation {
    readonly runId: string;
    readonly agentId: string;
    readonly token: string | undefined;
}

const PROTECTED_READ_PATH_PREFIXES = ['/runs', '/distributed-runs', '/fleet/reports'] as const;

export class ControlHttpSecurity {
    private readonly configuration: ControlHttpAccessConfiguration;
    private readonly controlService: ControlHttpSecurityDependencies['controlService'];

    constructor(dependencies: ControlHttpSecurityDependencies) {
        this.configuration = dependencies.configuration;
        this.controlService = dependencies.controlService;
    }

    toRequestPolicyRejection(request: Request, url: URL): ControlHttpRejection | undefined {
        const forwardedProtocol = request.headers.get('x-forwarded-proto');
        if (this.configuration.requireTls && url.protocol !== 'https:' && forwardedProtocol !== 'https') {
            return { status: 400, message: 'TLS is required.' };
        }

        const origin = request.headers.get('origin');
        const allowedOrigins = this.configuration.allowedOrigins;
        if (origin && allowedOrigins.length > 0 && !allowedOrigins.includes(origin)) {
            return { status: 403, message: 'Origin is not allowed.' };
        }
        return undefined;
    }

    async authorizeReadRequest(request: Request, url: URL): Promise<boolean> {
        if (!this.configuration.requireReadToken) {
            return true;
        }
        if (!this.configuration.adminToken && !this.configuration.operatorTokenSecret) {
            return false;
        }
        return await this.authorizeAdminRequest(request, url);
    }

    async authorizeAdminRequest(request: Request, url: URL): Promise<boolean> {
        const { adminToken, operatorTokenSecret } = this.configuration;
        if (!adminToken && !operatorTokenSecret) {
            return true;
        }

        const token = toControlRequestToken(request, url);
        if (adminToken && token === adminToken) {
            return true;
        }
        if (!operatorTokenSecret) {
            return false;
        }
        const verified = await verifyRallarBlackBoxOperatorToken({ token, secret: operatorTokenSecret });
        return verified.ok;
    }

    authorizeRunToken({ runId, agentId, token }: ControlRunTokenPresentation): boolean {
        const tokenRequired = this.configuration.requireRunToken ||
            this.controlService.hasActiveRunToken(runId, agentId);
        return !tokenRequired || this.controlService.validateRunToken(runId, agentId, token);
    }
}

export function isProtectedControlReadPath(pathname: string): boolean {
    return PROTECTED_READ_PATH_PREFIXES.some((prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`));
}

export function toControlRequestToken(request: Request, url: URL): string | undefined {
    const authorization = request.headers.get('authorization');
    if (authorization?.toLowerCase().startsWith('bearer ')) {
        return authorization.slice('bearer '.length).trim();
    }

    return request.headers.get('x-rallar-run-token')?.trim() ||
        url.searchParams.get('token')?.trim() ||
        undefined;
}
