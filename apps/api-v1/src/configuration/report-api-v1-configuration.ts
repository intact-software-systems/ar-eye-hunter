import { validateWebSocketHost } from '@shared/websocket/validate-web-socket-host.ts';

import type { ApiV1Configuration } from './api-v1-configuration.ts';
import { toApiV1ConfigurationStartupSummary } from './read-api-v1-configuration.ts';

/** Reports the validated configuration before a server composition starts its runtime. */
export function reportApiV1Configuration(
    configuration: ApiV1Configuration,
    output: Pick<Console, 'log' | 'warn'>
): void {
    output.log(JSON.stringify({
        event: 'api-v1.configuration',
        ...toApiV1ConfigurationStartupSummary(configuration)
    }));
    const hostMismatch = validateWebSocketHost(
        new URL(configuration.publicApi.apiBaseUrl),
        new URL(configuration.publicApi.wsBaseUrl)
    );
    if (hostMismatch !== null) {
        output.warn(JSON.stringify({
            event: 'api-v1.configuration-warning',
            code: 'websocket-host-mismatch',
            message: hostMismatch
        }));
    }
}
