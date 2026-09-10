type EnvReader = Readonly<Record<string, string | undefined>>;

export type FullStackControlWebServer = Readonly<{
    command: string;
    url: string;
    reuseExistingServer: boolean;
    timeout: number;
}>;

const DEFAULT_CONTROL_BASE_URL = 'http://127.0.0.1:5180';

export function readFullStackControlBaseUrl(
    env: EnvReader = process.env
): string {
    return normalizeBaseUrl(
        env.RALLAR_BLACK_BOX_CONTROL_BASE_URL?.trim() || DEFAULT_CONTROL_BASE_URL
    );
}

export function createFullStackControlWebServer(
    input: Readonly<{
        baseUrl?: string;
        reuseExistingServer?: boolean;
    }> = {}
): FullStackControlWebServer {
    const baseUrl = normalizeBaseUrl(
        input.baseUrl ?? readFullStackControlBaseUrl()
    );
    return {
        command: `cd ../rallar-black-box-control-server && PORT=${portFromBaseUrl(baseUrl)} deno task start`,
        url: `${baseUrl}/health`,
        reuseExistingServer: input.reuseExistingServer ?? true,
        timeout: 60_000
    };
}

export function toFullStackControlWebSocketUrl(baseUrl: string): string {
    const url = new URL(normalizeBaseUrl(baseUrl));
    url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
    url.pathname = '/control';
    url.search = '';
    url.hash = '';
    return normalizeBaseUrl(url.toString());
}

function portFromBaseUrl(baseUrl: string): number {
    const url = new URL(baseUrl);
    if (url.port) {
        return Number(url.port);
    }
    return url.protocol === 'https:' ? 443 : 80;
}

function normalizeBaseUrl(value: string): string {
    return value.endsWith('/') ? value.slice(0, -1) : value;
}
