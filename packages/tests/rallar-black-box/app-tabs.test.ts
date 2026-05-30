import { describe, expect, it } from 'vitest';
import {
    APP_TABS,
    DEFAULT_APP_MODE_ID,
    DEFAULT_APP_TAB_ID,
    appModeForTab,
    appModeFromValue,
    appTabInMode,
    appTabFromValue,
    appTabsForMode,
    defaultAppTabForMode,
    nextAppTab,
} from '../../../apps/rallar-black-box/src/app-tabs.ts';

describe('rallar-black-box app tabs', () => {
    it('parses URL tab values and aliases', () => {
        expect(appTabFromValue('quick-test')).toBe('quick-test');
        expect(appTabFromValue('quick')).toBe('quick-test');
        expect(appTabFromValue('smoke')).toBe('quick-test');
        expect(appTabFromValue('manual-rallar')).toBe('manual-rallar');
        expect(appTabFromValue('event-stream')).toBe('event-stream');
        expect(appTabFromValue('login')).toBe('auth');
        expect(appTabFromValue('rooms')).toBe('rooms-clients');
        expect(appTabFromValue('groups')).toBe('rooms-clients');
        expect(appTabFromValue('ws')).toBe('websocket');
        expect(appTabFromValue('realtime')).toBe('rtc-realtime');
        expect(appTabFromValue('rtc')).toBe('rtc-diagnostics');
        expect(appTabFromValue('data')).toBe('rallar-data');
        expect(appTabFromValue('media')).toBe('media');
        expect(appTabFromValue('trace')).toBe('rallar-trace');
        expect(appTabFromValue('server')).toBe('rallar-server');
        expect(appTabFromValue('flow')).toBe('flow-builder');
        expect(appTabFromValue('runs')).toBe('run-manager');
        expect(appTabFromValue('catalog')).toBe('shared-test');
        expect(appTabFromValue('artifacts')).toBe('shared-test');
    });

    it('parses workspace mode values and aliases', () => {
        expect(appModeFromValue('rallar')).toBe('rallar');
        expect(appModeFromValue('direct')).toBe('rallar');
        expect(appModeFromValue('black-box-runner')).toBe('black-box-runner');
        expect(appModeFromValue('runner')).toBe('black-box-runner');
        expect(appModeFromValue(undefined)).toBe(DEFAULT_APP_MODE_ID);
    });

    it('defaults unknown and empty tab values to the Quick Test tab', () => {
        expect(appTabFromValue(undefined)).toBe(DEFAULT_APP_TAB_ID);
        expect(appTabFromValue('')).toBe(DEFAULT_APP_TAB_ID);
        expect(appTabFromValue('unknown')).toBe(DEFAULT_APP_TAB_ID);
    });

    it('maps tabs to their workspace modes', () => {
        expect(APP_TABS.find(tab => tab.id === 'rooms-clients')?.label).toBe('Groups/Clients');
        expect(appModeForTab('quick-test')).toBe('rallar');
        expect(appModeForTab('manual-rallar')).toBe('black-box-runner');
        expect(appModeForTab('rtc-realtime')).toBe('rallar');
        expect(appModeForTab('rallar-data')).toBe('rallar');
        expect(appModeForTab('media')).toBe('rallar');
        expect(appModeForTab('rallar-trace')).toBe('rallar');
        expect(appModeForTab('rallar-server')).toBe('rallar');
        expect(appModeForTab('shared-test')).toBe('black-box-runner');
        expect(appModeForTab('run-manager')).toBe('black-box-runner');
        expect(defaultAppTabForMode('rallar')).toBe('quick-test');
        expect(defaultAppTabForMode('black-box-runner')).toBe('shared-test');
        expect(appTabInMode('websocket', 'rallar')).toBe(true);
        expect(appTabInMode('websocket', 'black-box-runner')).toBe(false);
        expect(appTabInMode('event-stream', 'rallar')).toBe(true);
        expect(appTabInMode('event-stream', 'black-box-runner')).toBe(true);
        expect(appTabsForMode('rallar').map(tab => tab.id)).toEqual([
            'quick-test',
            'auth',
            'rooms-clients',
            'websocket',
            'rtc-realtime',
            'topology',
            'rtc-diagnostics',
            'rallar-data',
            'media',
            'rallar-server',
            'rallar-trace',
            'event-stream',
        ]);
        expect(appTabsForMode('black-box-runner').map(tab => tab.id)).toEqual([
            'shared-test',
            'manual-rallar',
            'local-workbench',
            'flow-builder',
            'run-manager',
            'event-stream',
        ]);
    });

    it('walks Rallar tab order in both keyboard directions', () => {
        expect(nextAppTab('quick-test', 1)).toBe('auth');
        expect(nextAppTab('quick-test', -1)).toBe('event-stream');
        expect(nextAppTab('auth', 1)).toBe('rooms-clients');
        expect(nextAppTab('rooms-clients', 1)).toBe('websocket');
        expect(nextAppTab('websocket', 1)).toBe('rtc-realtime');
        expect(nextAppTab('rtc-realtime', 1)).toBe('topology');
        expect(nextAppTab('rtc-diagnostics', 1)).toBe('rallar-data');
        expect(nextAppTab('rallar-data', 1)).toBe('media');
        expect(nextAppTab('media', 1)).toBe('rallar-server');
        expect(nextAppTab('rallar-server', 1)).toBe('rallar-trace');
        expect(nextAppTab('rallar-trace', 1)).toBe('event-stream');
        expect(nextAppTab('event-stream', 1, 'rallar')).toBe(APP_TABS[0].id);
        expect(nextAppTab('auth', -1)).toBe('quick-test');
    });

    it('walks black-box-runner tab order in both keyboard directions', () => {
        expect(nextAppTab('shared-test', 1)).toBe('manual-rallar');
        expect(nextAppTab('manual-rallar', 1)).toBe('local-workbench');
        expect(nextAppTab('manual-rallar', -1)).toBe('shared-test');
        expect(nextAppTab('local-workbench', 1)).toBe('flow-builder');
        expect(nextAppTab('flow-builder', 1)).toBe('run-manager');
        expect(nextAppTab('run-manager', 1)).toBe('event-stream');
        expect(nextAppTab('event-stream', 1, 'black-box-runner')).toBe('shared-test');
        expect(nextAppTab('shared-test', -1)).toBe('event-stream');
    });
});
