// deno-lint-ignore-file no-explicit-any
import type {
    RallarBlackBoxTestWsCloseCommand,
    RallarBlackBoxTestWsOpenCommand,
    RallarBlackBoxTestWsSendCommand
} from '../../rallar-bb-test/types.ts';
import { toWsConnectionName } from '../ws/ws-wait-expectations.ts';
import {
    assertRemoteDestinationAllowed,
    assertRemotePayloadWithinLimit
} from './remote-browser-execution.ts';

export function toWsUrl(request: any): string | undefined {
    return request.url || request.path;
}

export function toRemoteWsPayload(request: any): any {
    return request.send !== undefined
        ? request.send
        : request.message !== undefined
        ? request.message
        : request.body;
}

export function toRemoteWsOpenCommand(
    commandId: string,
    interaction: any,
    context: any
): RallarBlackBoxTestWsOpenCommand {
    const request = interaction.request;
    const url = toWsUrl(request);
    assertRemoteDestinationAllowed({ request, context, url, label: 'WebSocket' });
    return {
        kind: 'ws.open',
        commandId,
        connection: toWsConnectionName(request),
        url,
        protocols: request.protocols,
        headers: request.headers,
        timeoutMs: request.timeoutMs,
        metadata: {
            blackBoxRunner: request
        }
    };
}

export function toRemoteWsSendCommand(
    commandId: string,
    interaction: any,
    context: any
): RallarBlackBoxTestWsSendCommand {
    const request = interaction.request;
    const data = toRemoteWsPayload(request);
    assertRemotePayloadWithinLimit({ request, context, value: data, label: 'WebSocket send' });
    return {
        kind: 'ws.send',
        commandId,
        connection: toWsConnectionName(request),
        data,
        timeoutMs: request.timeoutMs,
        metadata: {
            blackBoxRunner: request
        }
    };
}

export function toRemoteWsCloseCommand(
    commandId: string,
    interaction: any
): RallarBlackBoxTestWsCloseCommand {
    const request = interaction.request;
    return {
        kind: 'ws.close',
        commandId,
        connection: toWsConnectionName(request),
        code: request.closeCode !== undefined ? request.closeCode : request.code,
        reason: request.closeReason !== undefined ? request.closeReason : request.reason,
        timeoutMs: request.timeoutMs,
        metadata: {
            blackBoxRunner: request
        }
    };
}
