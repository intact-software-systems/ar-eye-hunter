// deno-lint-ignore-file no-explicit-any
import { executeLocalWsInteraction } from './execute-local-ws-interaction.ts';
import { rememberWsCloseEvent } from './local-websocket-state.ts';
import {
    executeRemoteWsInteraction,
    shouldExecuteRemoteWsInteraction
} from './remote-browser-websocket-interaction.ts';

export { rememberWsCloseEvent };

export function executeWsInteraction(interaction: any, config: any, context: any): Promise<any> {
    return shouldExecuteRemoteWsInteraction(interaction, context)
        ? executeRemoteWsInteraction(interaction, config, context)
        : executeLocalWsInteraction(interaction, config, context);
}
