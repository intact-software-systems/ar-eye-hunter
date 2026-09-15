import {
    isBlackBoxCommandRecord,
    isRallarMessagePayload
} from '@shared-test/black-box-runner/browser/rallar-browser-runtime/decode-black-box-rallar-command-input.ts';
import type { RallarMessagePayload } from '@shared-web/browser/messages/rallar-message-contracts.ts';

import { decodeStringLeaves } from './browser-command-placeholders.ts';

const RTC_READY_PEER_IDS_PLACEHOLDER = '{rtc.readyPeerIds}';
const RTC_READY_PEER_ID_PLACEHOLDER_PATTERN = /^\{rtc\.readyPeerIds\[(\d+)\]\}$/;

export function requiresRtcReadyPeerPlaceholder(send: RallarMessagePayload): boolean {
    return decodeStringLeaves(send).some((text) =>
        text === RTC_READY_PEER_IDS_PLACEHOLDER || RTC_READY_PEER_ID_PLACEHOLDER_PATTERN.test(text)
    );
}

/** `{rtc.readyPeerIds}` expands in place into the ready peers, so inside an array it spreads into that array. */
export function replaceRtcReadyPeerPlaceholders(
    send: RallarMessagePayload,
    readyPeerIds: readonly string[]
): RallarMessagePayload {
    if (typeof send === 'string') {
        return toReadyPeerReplacement(send, readyPeerIds);
    }
    if (Array.isArray(send)) {
        return send.flatMap((item) => {
            const replaced = isRallarMessagePayload(item) ? replaceRtcReadyPeerPlaceholders(item, readyPeerIds) : item;
            return Array.isArray(replaced) ? replaced : [replaced];
        });
    }
    if (!isBlackBoxCommandRecord(send)) {
        return send;
    }
    return Object.fromEntries(
        Object.entries(send).map(([key, item]) => [
            key,
            isRallarMessagePayload(item) ? replaceRtcReadyPeerPlaceholders(item, readyPeerIds) : item
        ])
    );
}

function toReadyPeerReplacement(text: string, readyPeerIds: readonly string[]): string | readonly string[] {
    if (text === RTC_READY_PEER_IDS_PLACEHOLDER) {
        return [...readyPeerIds];
    }
    const indexed = RTC_READY_PEER_ID_PLACEHOLDER_PATTERN.exec(text);
    if (!indexed) {
        return text;
    }
    const peerId = readyPeerIds[Number.parseInt(indexed[1] ?? '', 10)];
    if (!peerId) {
        throw new Error(
            `Cannot resolve recipe placeholder ${text}; only ${readyPeerIds.length} RTC ready peer(s) are available.`
        );
    }
    return peerId;
}
