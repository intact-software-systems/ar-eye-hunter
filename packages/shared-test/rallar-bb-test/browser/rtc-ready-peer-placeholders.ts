import type { RallarBlackBoxTestRtcSendCommand } from '../rallar-black-box-test-contracts.ts';

import { decodeStringLeaves } from './browser-command-placeholders.ts';
import { isBrowserCommandRecord } from './browser-command-values.ts';

type RtcSendValue = RallarBlackBoxTestRtcSendCommand['send'];

const RTC_READY_PEER_IDS_PLACEHOLDER = '{rtc.readyPeerIds}';
const RTC_READY_PEER_ID_PLACEHOLDER_PATTERN = /^\{rtc\.readyPeerIds\[(\d+)\]\}$/;

export function requiresRtcReadyPeerPlaceholder(send: RtcSendValue): boolean {
    return decodeStringLeaves(send).some((text) =>
        text === RTC_READY_PEER_IDS_PLACEHOLDER || RTC_READY_PEER_ID_PLACEHOLDER_PATTERN.test(text)
    );
}

/** `{rtc.readyPeerIds}` expands in place into the ready peers, so inside an array it spreads into that array. */
export function replaceRtcReadyPeerPlaceholders(send: RtcSendValue, readyPeerIds: readonly string[]): RtcSendValue {
    if (typeof send === 'string') {
        return toReadyPeerReplacement(send, readyPeerIds);
    }
    if (Array.isArray(send)) {
        return send.flatMap((item) => {
            const replaced = replaceRtcReadyPeerPlaceholders(item, readyPeerIds);
            return Array.isArray(replaced) ? replaced : [replaced];
        });
    }
    if (!isBrowserCommandRecord(send)) {
        return send;
    }
    return Object.fromEntries(
        Object.entries(send).map(([key, item]) => [key, replaceRtcReadyPeerPlaceholders(item, readyPeerIds)])
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
