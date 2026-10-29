import { beforeEach, expect, it } from 'vitest';

import type { RallarMessagesUsage } from '@shared-web/browser/rallar-messages.ts';
import { AL_PUBLICATION_STAGE_LIMITS } from '@shared/al-contracts/publication/al-publication-stage-limits.ts';
import { toIdleALOutboundPublicationStageReport } from '@shared/alm/outbound/publication/al-outbound-publication-stage.ts';
import type { ALStorageEvent } from '@shared/alm/storage/al-storage-event.ts';
import { AL_VOLATILE_SESSION_LIMITS } from '@shared/alm/volatile-budget/al-volatile-session-budget.ts';

import { events, facade, loadRuntime, resetFacade } from './browser-rallar-runtime-test-harness.ts';

const REPORT: RallarMessagesUsage = {
    usage: { admissions: 2, bytes: 640, oldestAgeMs: 800, tracks: 1 },
    own: { admissions: 1, bytes: 320 },
    inbound: { admissions: 1, bytes: 320 },
    limits: AL_VOLATILE_SESSION_LIMITS,
    overloaded: false,
    repliesHeld: 3,
    replyWaitsOpen: 1,
    publication: toIdleALOutboundPublicationStageReport(AL_PUBLICATION_STAGE_LIMITS)
};

const CONNECTION = {
    connection: 'ordering',
    rallar: { apiBaseUrl: 'https://api.example.test', applicationId: 'app-1', username: 'alice', password: 'secret' }
};

function emitStorage(event: ALStorageEvent): void {
    facade.records.defaultWrites.at(-1)?.diagnosticsPorts?.storage?.(event);
}

beforeEach(() => {
    resetFacade();
});

it('answers the facade ledger report once the facade is connected, with no ordering snapshot or marker stated yet', async () => {
    const runtime = await loadRuntime();
    facade.behavior.readUsage.mockReturnValue(REPORT);

    await expect(runtime.readAlmUsage()).resolves.toEqual({ ...REPORT, orderingTracks: 0, deliveredMarkers: 0 });
    await expect(runtime.readAlmUsage()).resolves.toMatchObject({ repliesHeld: 3, replyWaitsOpen: 1 });
});

it('answers undefined before the facade is connected, where the facade read would throw', async () => {
    const runtime = await loadRuntime();
    facade.behavior.isConnected.mockReturnValue(false);
    facade.behavior.readUsage.mockImplementation(() => {
        throw new Error('Rallar is not connected. Call rallar.connect() first.');
    });

    await expect(runtime.readAlmUsage()).resolves.toBeUndefined();
});

it('sums the latest ordering snapshots each inbound store stated, and counts from zero after a close', async () => {
    const runtime = await loadRuntime();
    facade.behavior.readUsage.mockReturnValue(REPORT);
    await runtime.connect(CONNECTION);

    emitStorage({ kind: 'ordering-tracks', storeId: 'browser-session-inbound:s-1/volatile', tracks: 255 });
    emitStorage({ kind: 'ordering-tracks', storeId: 'browser-session-inbound:s-1', tracks: 3 });
    emitStorage({ kind: 'ordering-tracks', storeId: 'browser-session-inbound:s-1/volatile', tracks: 256 });
    emitStorage({ kind: 'persist', outcome: 'granted' });

    await expect(runtime.readAlmUsage()).resolves.toMatchObject({ orderingTracks: 259 });
    expect(events.filter((event) => event.topic === 'rallar.browser.alm.storage')).toHaveLength(4);
    await runtime.close();
    await runtime.connect(CONNECTION);
    await expect(runtime.readAlmUsage()).resolves.toMatchObject({ orderingTracks: 0 });
});

it('sums the latest delivered markers each inbound store stated, and counts from zero after a close', async () => {
    const runtime = await loadRuntime();
    facade.behavior.readUsage.mockReturnValue(REPORT);
    await runtime.connect(CONNECTION);

    emitStorage({ kind: 'delivered-markers', storeId: 'browser-session-inbound:s-1/volatile', markers: 255 });
    emitStorage({ kind: 'delivered-markers', storeId: 'browser-session-inbound:s-1', markers: 3 });
    emitStorage({ kind: 'delivered-markers', storeId: 'browser-session-inbound:s-1/volatile', markers: 256 });
    emitStorage({ kind: 'ordering-tracks', storeId: 'browser-session-inbound:s-1', tracks: 2 });

    await expect(runtime.readAlmUsage()).resolves.toMatchObject({ orderingTracks: 2, deliveredMarkers: 259 });
    await runtime.close();
    await runtime.connect(CONNECTION);
    await expect(runtime.readAlmUsage()).resolves.toMatchObject({ orderingTracks: 0, deliveredMarkers: 0 });
});
