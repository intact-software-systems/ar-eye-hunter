import type {
    RallarBlackBoxTestCommandContext,
    RallarBlackBoxTestCommandOutcome,
    RallarBlackBoxTestSendObservation,
    RallarBlackBoxTestWsSendCommand
} from '../rallar-black-box-test-contracts.ts';

import { createBrowserCommandAbortScope, withBrowserCommandAbort } from './browser-command-cancellation.ts';
import type { CommandWithId, RallarBlackBoxBrowserRallarRuntimeResult } from './browser-command-contracts.ts';
import { requireBrowserCommandRuntime, type BrowserCommandEnvironment } from './browser-command-environment.ts';
import { replaceCommandPlaceholders } from './browser-command-placeholders.ts';
import { isRuntimeNotConnectedError } from './browser-command-values.ts';
import { toRallarWebSocketConnectionConfig } from './browser-rallar-command-input.ts';

export interface SendRallarWebSocketMessageInput {
    readonly environment: BrowserCommandEnvironment;
    readonly command: Extract<CommandWithId, { kind: 'ws.send'; }>;
    readonly context: RallarBlackBoxTestCommandContext;
    readonly connection: string;
}

/** A structured ws.send in browser-rallar mode rides the page runtime's signaling WebSocket, not a raw socket. */
export async function sendRallarWebSocketMessage(
    input: SendRallarWebSocketMessageInput
): Promise<RallarBlackBoxTestCommandOutcome> {
    const { environment, command, context, connection } = input;
    const data = replaceCommandPlaceholders(command.data, {
        config: context.config(),
        session: environment.readSession(),
        wsTicket: undefined
    });
    const sendStartedAtEpochMs = environment.now();
    const rallar = await writeRallarWebSocketMessage(input, data);
    const sendObservation: RallarBlackBoxTestSendObservation = {
        commandId: command.commandId,
        kind: command.kind,
        transport: 'ws',
        durationMs: Math.max(0, environment.now() - sendStartedAtEpochMs),
        ok: true,
        status: 'sent'
    };
    const via = 'rallar-signaling-websocket';
    context.recordEvent({
        kind: 'event',
        topic: 'rallar.bb.ws.sent_via_rallar_signaling',
        commandId: command.commandId,
        connection,
        transport: 'ws',
        severity: 'info',
        payload: { connection, via, rallar, sendObservation }
    });
    return { status: 'ok', value: { connection, via, sent: data, rallar, sendObservation } };
}

/** A page runtime that has not connected yet is connected once for this send, then the send is retried. */
async function writeRallarWebSocketMessage(
    input: SendRallarWebSocketMessageInput,
    data: RallarBlackBoxTestWsSendCommand['data']
): Promise<RallarBlackBoxBrowserRallarRuntimeResult> {
    const { environment, command, context } = input;
    const runtime = requireBrowserCommandRuntime(environment);
    if (!runtime.sendWs) {
        throw new Error('Browser Rallar runtime does not support ws.send.');
    }
    const abort = createBrowserCommandAbortScope(command, context, environment.now);
    try {
        return await withBrowserCommandAbort(runtime.sendWs(data), abort.signal);
    }
    catch (caught) {
        if (!isRuntimeNotConnectedError(caught)) {
            throw caught;
        }
        const connectionConfig = toRallarWebSocketConnectionConfig(command, context.config());
        await withBrowserCommandAbort(runtime.connect(connectionConfig), abort.signal);
        return await withBrowserCommandAbort(runtime.sendWs(data), abort.signal);
    }
    finally {
        abort.cleanup();
    }
}
