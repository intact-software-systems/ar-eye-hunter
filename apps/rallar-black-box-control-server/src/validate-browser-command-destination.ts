import type { RallarBlackBoxTestCommand } from '@shared-test/rallar-bb-test/rallar-black-box-test-contracts.ts';

export interface BrowserCommandDestinationPolicy {
    readonly httpAllowedHosts: readonly string[];
    readonly httpAllowedOrigins: readonly string[];
    readonly wsAllowedHosts: readonly string[];
    readonly wsAllowedOrigins: readonly string[];
}

interface BrowserCommandDestination {
    readonly value: string | undefined;
    readonly allowedOrigins: readonly string[];
    readonly allowedHosts: readonly string[];
    readonly label: string;
}

export function validateBrowserCommandDestination(
    command: RallarBlackBoxTestCommand,
    policy: BrowserCommandDestinationPolicy
): readonly string[] {
    if (command.kind === 'http.request') {
        return validateDestination({
            value: command.request.url ?? command.request.path,
            allowedOrigins: policy.httpAllowedOrigins,
            allowedHosts: policy.httpAllowedHosts,
            label: 'HTTP'
        });
    }

    if (command.kind === 'ws.open') {
        return validateDestination({
            value: command.url,
            allowedOrigins: policy.wsAllowedOrigins,
            allowedHosts: policy.wsAllowedHosts,
            label: 'WebSocket'
        });
    }

    return [];
}

function validateDestination(destination: BrowserCommandDestination): readonly string[] {
    if (!destination.value || (destination.allowedOrigins.length === 0 && destination.allowedHosts.length === 0)) {
        return [];
    }

    const parsed = URL.parse(destination.value);
    if (!parsed || destination.allowedOrigins.includes(parsed.origin)) {
        return [];
    }
    if (destination.allowedHosts.some((allowedHost) => isAllowedHost(parsed, allowedHost))) {
        return [];
    }
    return [`${destination.label} destination is not allowed: ${parsed.origin}`];
}

function isAllowedHost(destination: URL, allowedHost: string): boolean {
    if (allowedHost === destination.host || allowedHost === destination.hostname) {
        return true;
    }
    if (!allowedHost.startsWith('*.')) {
        return false;
    }

    const suffix = allowedHost.slice(1);
    return destination.hostname.endsWith(suffix) && destination.hostname.length > suffix.length;
}
