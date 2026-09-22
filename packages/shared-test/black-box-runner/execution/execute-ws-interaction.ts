// deno-lint-ignore-file no-explicit-any
import { executeLocalWsInteraction } from './execute-local-ws-interaction.ts';
import { rememberWsCloseEvent } from './local-websocket-session.ts';
import {
    isRemoteWsInteraction,
    runRemoteWsInteraction
} from './remote-browser-websocket-interaction.ts';

export { rememberWsCloseEvent };

export function executeWsInteraction(interaction: any, config: any, context: any): Promise<any> {
    return isRemoteWsInteraction(interaction, context)
        ? runRemoteWsInteraction(interaction, config, context)
        : executeLocalWsInteraction(interaction, config, context);
}
