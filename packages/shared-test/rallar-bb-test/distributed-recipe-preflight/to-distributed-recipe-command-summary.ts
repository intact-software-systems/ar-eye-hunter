import type { RallarBlackBoxTestCommand } from '../rallar-black-box-test-contracts.ts';
import { decodeRecord } from '../runtime/decode-runtime-result-values.ts';

export function toDistributedRecipeCommandSummary(command: RallarBlackBoxTestCommand): string {
    switch (command.kind) {
        case 'configure':
            return 'configure runtime';
        case 'recipe.load':
            return 'load recipe';
        case 'recipe.run':
            return command.recipe ? 'run inline recipe' : 'run loaded recipe';
        case 'recipe.cancel':
            return 'cancel loaded recipe';
        case 'rtc.connect':
            return [
                'connect RTC',
                command.connection,
                toRoomLabel(command)
            ].filter(Boolean).join(' - ');
        case 'rtc.send':
            return [
                'send RTC',
                command.connection,
                toRoomLabel(command)
            ].filter(Boolean).join(' - ');
        case 'rtc.stream':
            return [
                'stream RTC',
                command.transport,
                toRoomLabel(command)
            ].filter(Boolean).join(' - ');
        case 'ws.open':
            return ['open WebSocket', command.connection].filter(Boolean).join(' - ');
        case 'ws.send':
            return ['send WebSocket', command.connection].filter(Boolean).join(' - ');
        case 'ws.close':
            return ['close WebSocket', command.connection].filter(Boolean).join(' - ');
        case 'http.request':
            return `${command.request.method ?? 'GET'} ${
                command.request.path ?? command.request.url ?? 'HTTP request'
            }`;
        case 'health':
            return 'agent health';
        case 'stats':
            return 'agent stats';
        case 'close':
            return 'close transports';
        case 'reset':
            return 'reset agent runtime';
        default:
            return command.kind;
    }
}

function toRoomLabel(
    command: Extract<RallarBlackBoxTestCommand, { kind: 'rtc.connect' | 'rtc.send' | 'rtc.stream'; }>
): string | undefined {
    const roomRef = decodeRecord(command.roomRef);
    const send = command.kind === 'rtc.send' || command.kind === 'rtc.stream'
        ? decodeRecord(command.send)
        : {};
    const roomId = command.kind === 'rtc.connect' || command.kind === 'rtc.stream'
        ? command.roomId
        : undefined;
    return String(roomId ?? send.roomId ?? roomRef.groupId ?? roomRef.roomId ?? '') || undefined;
}
