import {
    describe,
    expect,
    it
} from 'vitest';
import { readHeadlessWorkerConfig } from '../../../apps/rallar-black-box/src/headless-worker-config.ts';
import { resolveRallarBlackBoxBootstrapConfig } from '../../shared-test/rallar-bb-test/browser-control-agent-config.ts';

const env = {
    RALLAR_BLACK_BOX_SPA_URL: 'https://blackbox.example.test',
    RALLAR_BLACK_BOX_CONTROL_URL: 'wss://control.example.test/control',
    RALLAR_API_BASE_URL: 'https://api.example.test',
    RALLAR_BLACK_BOX_RUN_ID: 'history',
    RALLAR_BLACK_BOX_ROOM_ID: 'history',
    RALLAR_BLACK_BOX_USERNAME: 'fixture',
    RALLAR_BLACK_BOX_PASSWORD: 'fixture'
};

describe('headless host event history', () => {
    it.each(['headless', 'operator-spa'])('forwards validated recent history into the %s launch', (entry) => {
        const config = readHeadlessWorkerConfig({
            env: { ...env, RALLAR_BLACK_BOX_HEADLESS_ENTRY: entry, RALLAR_BLACK_BOX_EVENT_HISTORY: 'recent', RALLAR_BLACK_BOX_EVENT_HISTORY_MAX_EVENTS: '7' }
        });
        expect(config.eventHistory).toEqual({ mode: 'recent', maxEvents: 7 });
        expect(resolveRallarBlackBoxBootstrapConfig(new URL(config.agents[0].url).search, {}, '').eventHistory).toEqual({ mode: 'recent', maxEvents: 7 });
    });
    it.each([
        { entry: 'headless', explicit: false },
        { entry: 'headless', explicit: true },
        { entry: 'operator-spa', explicit: false },
        { entry: 'operator-spa', explicit: true }
    ])('normalizes stale recent bounds for Full: $entry explicit=$explicit', ({ entry, explicit }) => {
        const config = readHeadlessWorkerConfig({
            env: {
                ...env,
                RALLAR_BLACK_BOX_SPA_URL: 'https://blackbox.example.test/?eventHistory=recent&eventHistoryMaxEvents=64',
                RALLAR_BLACK_BOX_HEADLESS_ENTRY: entry,
                ...(explicit ? { RALLAR_BLACK_BOX_EVENT_HISTORY: 'full' } : {})
            }
        });
        const query = new URL(config.agents[0].url).searchParams;
        expect(config.eventHistory).toEqual({ mode: 'full' });
        expect(query.get('eventHistory')).toBe('full');
        expect(query.has('eventHistoryMaxEvents')).toBe(false);
        const bootstrap = resolveRallarBlackBoxBootstrapConfig(query.toString(), {}, '');
        expect(bootstrap.eventHistory).toEqual({ mode: 'full' });
        expect(bootstrap.issues).toEqual([]);
    });

    it('rejects malformed combinations before producing any worker launch', () => {
        expect(() => readHeadlessWorkerConfig({ env: { ...env, RALLAR_BLACK_BOX_EVENT_HISTORY: 'full', RALLAR_BLACK_BOX_EVENT_HISTORY_MAX_EVENTS: '2' } }))
            .toThrow(/event history/i);
    });
});
