import { describe, expect, it } from 'vitest';
import {
    APP_TABS,
    appModeForTab,
    appModeFromValue,
    appTabFromValue,
    appTabInMode,
    appTabsForMode,
    DEFAULT_APP_MODE_ID,
    DEFAULT_APP_TAB_ID,
    defaultAppTabForMode,
    nextAppTab,
    runnerAdvancedSurfaceForTab,
    visibleAppTabForTab
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
        expect(appTabFromValue('crdt')).toBe('crdt-health');
        expect(appTabFromValue('crdt-health')).toBe('crdt-health');
        expect(appTabFromValue('media')).toBe('media');
        expect(appTabFromValue('trace')).toBe('rallar-trace');
        expect(appTabFromValue('server')).toBe('rallar-server');
        expect(appTabFromValue('flow')).toBe('builder');
        expect(appTabFromValue('runs')).toBe('runs');
        expect(appTabFromValue('fleet')).toBe('fleet');
        expect(appTabFromValue('fleet-report')).toBe('fleet');
        expect(appTabFromValue('distributed')).toBe('distributed-recipes');
        expect(appTabFromValue('catalog')).toBe('recipes');
        expect(appTabFromValue('recipes')).toBe('recipes');
        expect(appTabFromValue('artifacts')).toBe('shared-test');
        expect(appTabFromValue('advanced')).toBe('advanced');
        expect(visibleAppTabForTab('manual-rallar')).toBe('advanced');
        expect(visibleAppTabForTab('local-workbench')).toBe('advanced');
        expect(visibleAppTabForTab('run-manager')).toBe('advanced');
        expect(visibleAppTabForTab('distributed-recipes')).toBe('advanced');
        expect(visibleAppTabForTab('shared-test')).toBe('advanced');
        expect(visibleAppTabForTab('flow-builder')).toBe('builder');
        expect(runnerAdvancedSurfaceForTab('manual-rallar')).toBe('manual');
        expect(runnerAdvancedSurfaceForTab('local-workbench')).toBe('workbench');
        expect(runnerAdvancedSurfaceForTab('run-manager')).toBe('run-manager');
        expect(runnerAdvancedSurfaceForTab('distributed-recipes')).toBe('distributed');
        expect(runnerAdvancedSurfaceForTab('shared-test')).toBe('shared-test');
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
        expect(APP_TABS.find((tab) => tab.id === 'rooms-clients')?.label).toBe('Groups/Clients');
        expect(APP_TABS.find((tab) => tab.id === 'crdt-health')?.label).toBe('CRDT');
        expect(appModeForTab('quick-test')).toBe('rallar');
        expect(appModeForTab('manual-rallar')).toBe('black-box-runner');
        expect(appModeForTab('rtc-realtime')).toBe('rallar');
        expect(appModeForTab('rallar-data')).toBe('rallar');
        expect(appModeForTab('crdt-health')).toBe('rallar');
        expect(appModeForTab('media')).toBe('rallar');
        expect(appModeForTab('rallar-trace')).toBe('rallar');
        expect(appModeForTab('rallar-server')).toBe('rallar');
        expect(appModeForTab('recipes')).toBe('black-box-runner');
        expect(appModeForTab('runs')).toBe('black-box-runner');
        expect(appModeForTab('fleet')).toBe('black-box-runner');
        expect(appModeForTab('builder')).toBe('black-box-runner');
        expect(appModeForTab('advanced')).toBe('black-box-runner');
        expect(appModeForTab('shared-test')).toBe('black-box-runner');
        expect(appModeForTab('run-manager')).toBe('black-box-runner');
        expect(appModeForTab('distributed-recipes')).toBe('black-box-runner');
        expect(defaultAppTabForMode('rallar')).toBe('quick-test');
        expect(defaultAppTabForMode('black-box-runner')).toBe('recipes');
        expect(appTabInMode('websocket', 'rallar')).toBe(true);
        expect(appTabInMode('websocket', 'black-box-runner')).toBe(false);
        expect(appTabInMode('event-stream', 'rallar')).toBe(true);
        expect(appTabInMode('event-stream', 'black-box-runner')).toBe(true);
        expect(appTabInMode('manual-rallar', 'black-box-runner')).toBe(false);
        expect(appTabInMode('run-manager', 'black-box-runner')).toBe(false);
        expect(appTabsForMode('rallar').map((tab) => tab.id)).toEqual([
            'quick-test',
            'auth',
            'rooms-clients',
            'websocket',
            'rtc-realtime',
            'topology',
            'rtc-diagnostics',
            'rallar-data',
            'crdt-health',
            'media',
            'rallar-server',
            'rallar-trace',
            'event-stream'
        ]);
        expect(appTabsForMode('black-box-runner').map((tab) => tab.id)).toEqual([
            'recipes',
            'runs',
            'fleet',
            'builder',
            'event-stream',
            'advanced'
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
        expect(nextAppTab('rallar-data', 1)).toBe('crdt-health');
        expect(nextAppTab('crdt-health', 1)).toBe('media');
        expect(nextAppTab('media', 1)).toBe('rallar-server');
        expect(nextAppTab('rallar-server', 1)).toBe('rallar-trace');
        expect(nextAppTab('rallar-trace', 1)).toBe('event-stream');
        expect(nextAppTab('event-stream', 1, 'rallar')).toBe(APP_TABS[0].id);
        expect(nextAppTab('auth', -1)).toBe('quick-test');
    });

    it('walks black-box-runner tab order in both keyboard directions', () => {
        expect(nextAppTab('recipes', 1)).toBe('runs');
        expect(nextAppTab('runs', 1)).toBe('fleet');
        expect(nextAppTab('fleet', 1)).toBe('builder');
        expect(nextAppTab('fleet', -1)).toBe('runs');
        expect(nextAppTab('builder', 1)).toBe('event-stream');
        expect(nextAppTab('event-stream', 1, 'black-box-runner')).toBe('advanced');
        expect(nextAppTab('advanced', 1)).toBe('recipes');
        expect(nextAppTab('advanced', -1)).toBe('event-stream');
        expect(nextAppTab('recipes', -1)).toBe('advanced');
    });
});
