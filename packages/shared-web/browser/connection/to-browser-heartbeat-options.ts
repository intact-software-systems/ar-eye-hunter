import type { BrowserOwnWsConnectionGeneration } from '@shared-web/browser/connection/browser-own-ws-connection-generation.ts';
import type { InitialiseBrowserTransportInput } from '@shared-web/browser/connection/initialise-browser-middleware.ts';
import type { InitHeartbeatOptions } from '@shared-web/browser/session/browser-session-heartbeat.ts';
import { toGroupPresencePublicationKey } from '@shared/api/group-presence/to-group-presence-publication-key.ts';
import { toError } from '@shared/resilience/to-error.ts';

export function toBrowserHeartbeatOptions(
    input: InitialiseBrowserTransportInput,
    ownWsConnectionGeneration: BrowserOwnWsConnectionGeneration
): InitHeartbeatOptions {
    return {
        publicationKey: toGroupPresencePublicationKey(input.publicationCrypto),
        authSession: input.session,
        scope: input.options.scope,
        ownWsConnectionGeneration,
        onAuthInvalid: input.options.onAuthInvalid
            ? (caught) => input.options.onAuthInvalid?.(toError(caught))
            : undefined
    };
}
