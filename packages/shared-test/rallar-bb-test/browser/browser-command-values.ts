import { isBlackBoxCommandRecord } from '@shared-test/black-box-runner/browser/rallar-browser-runtime/decode-black-box-rallar-command-input.ts';
import type { RallarMessagePayload } from '@shared-web/browser/messages/rallar-message-contracts.ts';
import type { RallarBlackBoxTestConfig } from '../rallar-black-box-test-contracts.ts';
import type { RallarBlackBoxTestRecord } from '../rallar-black-box-test-contracts.ts';

import type { RallarBlackBoxBrowserRallarTransport } from './browser-command-contracts.ts';

const RTC_TRANSPORTS: readonly RallarBlackBoxBrowserRallarTransport[] = ['realtime', 'messages.rtc', 'messages.ws'];

export function decodeBrowserCommandRecord(value: unknown): RallarBlackBoxTestRecord | undefined {
    return isBlackBoxCommandRecord(value) ? value : undefined;
}

/** Any present, non-null field reads in its String form. */
export function decodeBrowserCommandString(value: unknown): string | undefined {
    return value === undefined || value === null ? undefined : String(value);
}

export function decodeRtcTransport(value: unknown): RallarBlackBoxBrowserRallarTransport | undefined {
    return typeof value === 'string' ? RTC_TRANSPORTS.find((transport) => transport === value) : undefined;
}

export function toPositiveInteger(value: number | undefined, fallback: number): number {
    return value !== undefined && Number.isInteger(value) && value > 0 ? value : fallback;
}

/** Structured signaling sends may acquire an SDK connection; raw WebSocket writes never do. */
export function isRallarSignalingWebSocketMessage(
    data: RallarMessagePayload,
    config: RallarBlackBoxTestConfig | undefined
): boolean {
    return config?.control?.providerMode === 'browser-rallar' && isBlackBoxCommandRecord(data) &&
        ['typeId', 'topicId', 'contextId', 'resourceId'].some((key) => data[key] !== undefined);
}
