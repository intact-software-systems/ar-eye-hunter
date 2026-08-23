import type { RallarBlackBoxTestCommand } from '@shared-test/rallar-bb-test/types.ts';

import type { BlackBoxControlServerConfiguration } from './control-server-configuration.ts';

export function validateBrowserCommandDestination(
    command: RallarBlackBoxTestCommand,
    configuration: BlackBoxControlServerConfiguration
): string | undefined {
    if (command.kind === 'http.request') {
        return validateDestination({
            value: command.request.url ?? command.request.path,
            allowedOrigins: configuration.httpAllowedOrigins,
            allowedHosts: configuration.httpAllowedHosts,
            label: 'HTTP'
        });
    }

    if (command.kind === 'ws.open') {
        return validateDestination({
            value: command.url,
            allowedOrigins: configuration.wsAllowedOrigins,
            allowedHosts: configuration.wsAllowedHosts,
            label: 'WebSocket'
        });
    }

    return undefined;
}

interface BrowserCommandDestinationInput {
    readonly value?: string;
    readonly allowedOrigins: readonly string[];
    readonly allowedHosts: readonly string[];
    readonly label: string;
}

function validateDestination(input: BrowserCommandDestinationInput): string | undefined {
    if (
        !input.value ||
        (input.allowedOrigins.length === 0 && input.allowedHosts.length === 0)
    ) {
        return undefined;
    }

    let parsed: URL;
    try {
        parsed = new URL(input.value);
    }
    catch (_error) {
        return undefined;
    }

    if (input.allowedOrigins.includes(parsed.origin)) {
        return undefined;
    }

    if (
        input.allowedHosts.some((allowedHost) => hostMatches(parsed.host, parsed.hostname, allowedHost))
    ) {
        return undefined;
    }

    return `${input.label} destination is not allowed: ${parsed.origin}`;
}

function hostMatches(host: string, hostname: string, allowedHost: string): boolean {
    if (allowedHost === host || allowedHost === hostname) {
        return true;
    }
    if (!allowedHost.startsWith('*.')) {
        return false;
    }

    const suffix = allowedHost.slice(1);
    return hostname.endsWith(suffix) && hostname.length > suffix.length;
}
