type EnvReader = Readonly<{
    get(name: string): string | undefined;
}>;

export type AuthenticatedWsSmokeConfig =
    | Readonly<{
        enabled: false;
        reason: string;
    }>
    | Readonly<{
        enabled: true;
        apiBaseUrl: string;
        origin: string;
        username: string;
        password: string;
        timeoutMs: number;
    }>;

export type ApiConfigLike = Readonly<{
    apiBaseUrl?: string;
    wsBaseUrl?: string;
}>;

export type AuthSessionLike = Readonly<{
    accessToken: string;
    clientId: string;
    sessionId: string;
}>;

export type WsTicketLike = Readonly<{
    sessionId: string;
    ticket: string;
}>;

export function readAuthenticatedWsSmokeConfig(
    env: EnvReader = Deno.env
): AuthenticatedWsSmokeConfig {
    const username = firstNonEmpty(
        env.get('RALLAR_SMOKE_USERNAME'),
        env.get('RALLAR_BLACK_BOX_USERNAME')
    );
    const password = firstNonEmpty(
        env.get('RALLAR_SMOKE_PASSWORD'),
        env.get('RALLAR_BLACK_BOX_PASSWORD')
    );
    if (!username || !password) {
        return {
            enabled: false,
            reason:
                'Set RALLAR_SMOKE_USERNAME/RALLAR_SMOKE_PASSWORD or RALLAR_BLACK_BOX_USERNAME/RALLAR_BLACK_BOX_PASSWORD.'
        };
    }

    const apiHost = firstNonEmpty(env.get('RALLAR_API_HOST')) ??
        'api.rallar.intactss.com';
    const blackboxHost = firstNonEmpty(env.get('RALLAR_BLACKBOX_HOST')) ??
        'blackbox.rallar.intactss.com';

    return {
        enabled: true,
        apiBaseUrl: normalizeBaseUrl(
            firstNonEmpty(env.get('RALLAR_API_BASE_URL')) ??
                `https://${apiHost}`
        ),
        origin: normalizeBaseUrl(
            firstNonEmpty(env.get('RALLAR_SMOKE_ORIGIN')) ??
                `https://${blackboxHost}`
        ),
        username,
        password,
        timeoutMs: readPositiveInteger(
            env.get('RALLAR_SMOKE_TIMEOUT_MS'),
            10_000
        )
    };
}

export function validateAuthenticatedWsConfig(
    config: Extract<AuthenticatedWsSmokeConfig, { enabled: true; }>,
    apiConfig: ApiConfigLike
): void {
    const apiBaseUrl = normalizeBaseUrl(apiConfig.apiBaseUrl ?? config.apiBaseUrl);
    const wsBaseUrl = normalizeBaseUrl(apiConfig.wsBaseUrl ?? '');
    if (!wsBaseUrl) {
        throw new Error('CONFIG: /api/config did not include wsBaseUrl');
    }

    const apiUrl = new URL(apiBaseUrl);
    const wsUrl = new URL(wsBaseUrl);
    if (apiUrl.protocol === 'https:' && wsUrl.protocol !== 'wss:') {
        throw new Error(
            `CONFIG: apiBaseUrl is HTTPS but wsBaseUrl is not WSS (${wsBaseUrl})`
        );
    }
}

export function buildAuthenticatedWsUrl(
    config: Extract<AuthenticatedWsSmokeConfig, { enabled: true; }>,
    apiConfig: ApiConfigLike,
    ticket: WsTicketLike
): string {
    validateAuthenticatedWsConfig(config, apiConfig);
    const wsBaseUrl = normalizeBaseUrl(apiConfig.wsBaseUrl ?? '');
    const url = new URL(
        `/api/ws/${encodeURIComponent(ticket.sessionId)}`,
        `${wsBaseUrl}/`
    );
    url.searchParams.set('ticket', ticket.ticket);
    return url.toString();
}

export async function runAuthenticatedWsSmoke(
    config: Extract<AuthenticatedWsSmokeConfig, { enabled: true; }>
): Promise<void> {
    const apiConfig = await fetchJson<ApiConfigLike>(
        `${config.apiBaseUrl}/api/config`,
        {
            headers: {
                origin: config.origin
            }
        },
        config,
        'CONFIG'
    );
    validateAuthenticatedWsConfig(config, apiConfig);

    const authSession = await fetchJson<AuthSessionLike>(
        `${config.apiBaseUrl}/api/auth/login`,
        {
            method: 'POST',
            headers: {
                'content-type': 'application/json',
                origin: config.origin
            },
            body: JSON.stringify({
                username: config.username,
                password: config.password
            })
        },
        config,
        'LOGIN'
    );

    const ticket = await fetchJson<WsTicketLike>(
        `${config.apiBaseUrl}/api/auth/ws-ticket`,
        {
            method: 'POST',
            headers: {
                authorization: `Bearer ${authSession.accessToken}`,
                'x-client-id': authSession.clientId,
                origin: config.origin
            }
        },
        config,
        'WS_TICKET'
    );

    const wsUrl = buildAuthenticatedWsUrl(config, apiConfig, ticket);
    await openWebSocket(wsUrl, config.timeoutMs);
}

async function fetchJson<T>(
    url: string,
    init: RequestInit,
    config: Extract<AuthenticatedWsSmokeConfig, { enabled: true; }>,
    label: string
): Promise<T> {
    const response = await fetch(url, init);
    assertCorsResponse(response, config.origin, label);
    if (!response.ok) {
        const body = await response.text().catch(() => '');
        throw new Error(`${label}: HTTP ${response.status} ${body}`.trim());
    }

    return await response.json() as T;
}

function assertCorsResponse(response: Response, origin: string, label: string): void {
    const allowOrigin = response.headers.get('access-control-allow-origin');
    if (!allowOrigin) {
        throw new Error(`${label}: missing access-control-allow-origin for ${origin}`);
    }
    if (allowOrigin !== '*' && allowOrigin !== origin) {
        throw new Error(
            `${label}: access-control-allow-origin ${allowOrigin} does not allow ${origin}`
        );
    }
}

function openWebSocket(url: string, timeoutMs: number): Promise<void> {
    return new Promise((resolve, reject) => {
        const socket = new WebSocket(url);
        let settled = false;
        const timer = setTimeout(() => {
            if (settled) {
                return;
            }
            settled = true;
            try {
                socket.close(1000, 'smoke-timeout');
            }
            catch {
                // Best effort cleanup; the timeout error below is the useful signal.
            }
            reject(new Error(`WEBSOCKET_TIMEOUT: upgrade did not open within ${timeoutMs}ms`));
        }, timeoutMs);

        socket.onopen = () => {
            if (settled) {
                return;
            }
            settled = true;
            clearTimeout(timer);
            socket.close(1000, 'smoke-ok');
            resolve();
        };
        socket.onerror = () => {
            if (settled) {
                return;
            }
            settled = true;
            clearTimeout(timer);
            reject(
                new Error(
                    'WEBSOCKET_UPGRADE: public WebSocket upgrade failed; check TLS, Caddy reverse_proxy, and /api/ws routing.'
                )
            );
        };
        socket.onclose = (event) => {
            if (settled) {
                return;
            }
            settled = true;
            clearTimeout(timer);
            reject(
                new Error(
                    `WEBSOCKET_CLOSED: socket closed before open (${event.code} ${event.reason})`
                )
            );
        };
    });
}

function firstNonEmpty(...values: readonly (string | undefined)[]): string | undefined {
    for (const value of values) {
        const trimmed = value?.trim();
        if (trimmed) {
            return trimmed;
        }
    }
    return undefined;
}

function normalizeBaseUrl(value: string): string {
    return value.trim().replace(/\/+$/, '');
}

function readPositiveInteger(value: string | undefined, fallback: number): number {
    const parsed = Number(value);
    return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

if (import.meta.main) {
    const config = readAuthenticatedWsSmokeConfig();
    if (!config.enabled) {
        console.log(`Skipping authenticated WS smoke: ${config.reason}`);
        Deno.exit(0);
    }

    try {
        await runAuthenticatedWsSmoke(config);
        console.log('Authenticated API WebSocket smoke passed.');
    }
    catch (error) {
        console.error(error instanceof Error ? error.message : String(error));
        Deno.exit(1);
    }
}
