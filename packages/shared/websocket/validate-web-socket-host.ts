/** Compares parsed public authorities without exposing credentials or URL parameters. */
export function validateWebSocketHost(apiUrl: URL, webSocketUrl: URL): string | null {
    if (apiUrl.host === webSocketUrl.host) {
        return null;
    }
    return `WebSocket host "${webSocketUrl.host}" does not match API host "${apiUrl.host}". ` +
        'Check RALLAR_API_BASE_URL and RALLAR_WS_BASE_URL.';
}
