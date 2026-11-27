import { afterEach, expect, it, vi } from 'vitest';
import { preparePickupAlerts } from '../../../../../examples/pickup-event/pickup-alerts.ts';

vi.mock('@shared-web/browser/rooms/events/court-ready-notifications.ts', () => ({
    readCourtAlertPublicKey: async () => 'public-key'
}));
afterEach(() => vi.unstubAllGlobals());

it('uses the event app registration when an installed parent app already controls the window', async () => {
    const installed = { active: { state: 'activated' }, update: async () => {} };
    const parent = { active: { state: 'activated' } };
    vi.stubGlobal('window', { Notification: {}, PushManager: {} });
    vi.stubGlobal('navigator', { userAgent: 'browser', serviceWorker: {
        register: async () => installed, ready: Promise.resolve(parent)
    } });
    const notice = { textContent: '' };
    expect((await preparePickupAlerts(notice, new AbortController().signal))?.registration).toBe(installed);
});
