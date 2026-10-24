import type { ApiJsonObject, ApiJsonValue } from '@shared/api/api-json-value.ts';

import { decodeGrowthLines, isPositiveNumber, type DecodedGrowthPoints } from './decode-growth-lines.ts';
import { isApiJsonObject, type GrowthSamplePoint } from './growth-series.ts';

/** One agent's stats snapshot as a sample point, and whether its page heap was read without a forced collection. */
interface BrowserStatsSnapshot {
    readonly point: GrowthSamplePoint;
    readonly unforcedPageHeap: boolean;
}

/**
 * Each line is one poll of the control run: the `stats` and `events` envelopes it held. A stats event carries one
 * agent's stats snapshot: a periodic stats, a census reading with `browser`, or a `stats` command's ledger reading.
 * Polls overlap, so a snapshot seen twice counts once. Each page heap dropped for lacking a forced collection counts
 * as one skipped line, as an unforced API heap sample does.
 */
export function decodeGrowthBrowserStats(text: string): DecodedGrowthPoints {
    const seen = new Set<string>();
    let unforcedPageHeaps = 0;
    const decoded = decodeGrowthLines(text, (value) => {
        const poll = isApiJsonObject(value) ? value.value : undefined;
        if (!isApiJsonObject(poll)) {
            return undefined;
        }
        return [poll.stats, poll.events]
            .flatMap((envelopes) => Array.isArray(envelopes) ? envelopes.flatMap(decodeBrowserStatsSnapshot) : [])
            .filter(({ point }) => isFirstSnapshot(point, seen))
            .map(({ point, unforcedPageHeap }) => {
                unforcedPageHeaps += Number(unforcedPageHeap);
                return point;
            });
    });
    return { points: decoded.points, skippedLines: decoded.skippedLines + unforcedPageHeaps };
}

function isFirstSnapshot(point: GrowthSamplePoint, seen: Set<string>): boolean {
    const census = isApiJsonObject(point.value) && point.value.browser !== undefined;
    const key = `${point.agentId}:${point.atEpochMs}:${census ? 'census' : 'stats'}`;
    const first = !seen.has(key);
    seen.add(key);
    return first;
}

function decodeBrowserStatsSnapshot(envelope: ApiJsonValue): readonly BrowserStatsSnapshot[] {
    const event = isApiJsonObject(envelope) ? envelope.payload : undefined;
    const snapshot = isApiJsonObject(event) && event.kind === 'stats' ? event.payload : undefined;
    if (!isApiJsonObject(envelope) || typeof envelope.agentId !== 'string' || !isApiJsonObject(snapshot)) {
        return [];
    }
    const atEpochMs = isPositiveNumber(snapshot.atEpochMs) ? snapshot.atEpochMs : envelope.atEpochMs;
    return isPositiveNumber(atEpochMs)
        ? [{
            point: { atEpochMs, agentId: envelope.agentId, serviceId: null, value: toBrowserStatsValue(snapshot) },
            unforcedPageHeap: hasUnforcedPageHeap(snapshot)
        }]
        : [];
}

function hasUnforcedPageHeap(snapshot: ApiJsonObject): boolean {
    const pageHeap = isApiJsonObject(snapshot.browser) ? snapshot.browser.pageHeap : undefined;
    return isApiJsonObject(pageHeap) && pageHeap.forcedGc !== true;
}

/**
 * A page heap read without a forced collection measures garbage awaiting collection, so it is dropped, as an API heap
 * sample is; the rest of the census stays. The census lists IndexedDB databases by their scoped names; the readers
 * address rows by database family (the name before its first `:`), as `family` and `family/store` totals.
 */
function toBrowserStatsValue(snapshot: ApiJsonObject): ApiJsonObject {
    const browser = snapshot.browser;
    if (!isApiJsonObject(browser)) {
        return snapshot;
    }
    const { pageHeap, ...census } = browser;
    const forcedPageHeap: ApiJsonObject = isApiJsonObject(pageHeap) && pageHeap.forcedGc === true ? { pageHeap } : {};
    return { ...snapshot, browser: { ...census, ...forcedPageHeap, ...toIndexedDbRows(browser.indexedDb) } };
}

function toIndexedDbRows(indexedDb: ApiJsonValue | undefined): ApiJsonObject {
    if (!isApiJsonObject(indexedDb) || !Array.isArray(indexedDb.databases)) {
        return {};
    }
    const indexedDbRows = new Map<string, number>();
    const addRows = (key: string, rows: number) => indexedDbRows.set(key, (indexedDbRows.get(key) ?? 0) + rows);
    for (const database of indexedDb.databases.filter(isApiJsonObject)) {
        const family = String(database.name).split(':')[0]!;
        const stores = Array.isArray(database.stores) ? database.stores.filter(isApiJsonObject) : [];
        for (const store of stores) {
            const rows = isPositiveNumber(store.rows) ? store.rows : 0;
            addRows(family, rows);
            addRows(`${family}/${String(store.name)}`, rows);
        }
    }
    return { indexedDbRows: Object.fromEntries(indexedDbRows) };
}
