import type { RallarMessagePayload } from '@shared-web/browser/messages/rallar-message-contracts.ts';
import type {
    RallarBlackBoxTestCommandContext,
    RallarBlackBoxTestCommandOutcome,
    RallarBlackBoxTestRecord,
    RallarBlackBoxTestSendObservation
} from '../rallar-black-box-test-contracts.ts';

import { createBrowserCommandAbortScope, withBrowserCommandAbort } from './browser-command-cancellation.ts';
import type { CommandWithId } from './browser-command-contracts.ts';
import { requireBrowserCommandRuntime, type BrowserCommandEnvironment } from './browser-command-environment.ts';
import { replaceCommandPlaceholders } from './browser-command-placeholders.ts';
import { decodeBrowserCommandRecord } from './browser-command-values.ts';
import { toRallarWebSocketConnectionConfig } from './browser-rallar-command-input.ts';

export interface SendRallarWebSocketMessageInput {
    readonly environment: BrowserCommandEnvironment;
    readonly command: Extract<CommandWithId, { kind: 'ws.send'; }>;
    readonly context: RallarBlackBoxTestCommandContext;
    readonly connection: string;
    readonly data: RallarMessagePayload;
}

const RUNTIME_NOT_CONNECTED_MESSAGE = 'Black-box Rallar runtime is not connected.';

export async function sendRallarWebSocketMessage(
    input: SendRallarWebSocketMessageInput
): Promise<RallarBlackBoxTestCommandOutcome> {
    const { environment, command, context, connection } = input;
    const data = replaceCommandPlaceholders(input.data, {
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

/** A send on a runtime that has not connected yet connects once with the connection the command names and retries. */
async function writeRallarWebSocketMessage(
    input: SendRallarWebSocketMessageInput,
    data: RallarMessagePayload
): Promise<RallarBlackBoxTestRecord | undefined> {
    const { environment, command, context } = input;
    const runtime = requireBrowserCommandRuntime(environment);
    if (!runtime.sendWs) {
        throw new Error('Browser Rallar runtime does not support ws.send.');
    }
    const abort = createBrowserCommandAbortScope(command, context, environment.now);
    try {
        return decodeBrowserCommandRecord(await withBrowserCommandAbort(runtime.sendWs(data), abort.signal));
    }
    catch (caught) {
        if (!(caught instanceof Error) || !caught.message.includes(RUNTIME_NOT_CONNECTED_MESSAGE)) {
            throw caught;
        }
        const connectionConfig = toRallarWebSocketConnectionConfig(command, context.config());
        await withBrowserCommandAbort(runtime.connect(connectionConfig), abort.signal);
        return decodeBrowserCommandRecord(await withBrowserCommandAbort(runtime.sendWs(data), abort.signal));
    }
    finally {
        abort.cleanup();
    }
}
