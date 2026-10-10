import type { BlackBoxRallarDeliveryObservation } from '@shared-test/black-box-runner/browser/rallar-browser-runtime/black-box-rallar-operation-contracts.ts';
import { normalizeJson, type LiveRtcJsonRecord } from '../../../tests/playwright/rallar-black-box/live-rtc-evidence-json.ts';

/**
 * Spreads a real delivery observation, then explicitly named contamination the producer never emits.
 * An undefined field is dropped, as the JSON from the page drops it (a send with no receipt has no receiptMode).
 */
export function toDeliveryObservationFixture(
    observation: BlackBoxRallarDeliveryObservation,
    contamination: Readonly<LiveRtcJsonRecord> = {}
) {
    const fields = Object.entries({ ...observation, ...contamination }).filter(([, value]) => value !== undefined);
    return normalizeJson(Object.fromEntries(fields));
}
