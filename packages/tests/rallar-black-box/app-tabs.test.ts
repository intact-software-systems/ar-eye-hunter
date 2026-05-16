import { describe, expect, it } from 'vitest';
import {
    APP_TABS,
    DEFAULT_APP_TAB_ID,
    appTabFromValue,
    nextAppTab,
} from '../../../apps/rallar-black-box/src/app-tabs.ts';

describe('rallar-black-box app tabs', () => {
    it('parses URL tab values and aliases', () => {
        expect(appTabFromValue('manual-rallar')).toBe('manual-rallar');
        expect(appTabFromValue('event-stream')).toBe('event-stream');
        expect(appTabFromValue('rtc')).toBe('rtc-diagnostics');
        expect(appTabFromValue('server')).toBe('rallar-server');
    });

    it('defaults unknown and empty tab values to the manual Rallar tab', () => {
        expect(appTabFromValue(undefined)).toBe(DEFAULT_APP_TAB_ID);
        expect(appTabFromValue('')).toBe(DEFAULT_APP_TAB_ID);
        expect(appTabFromValue('unknown')).toBe(DEFAULT_APP_TAB_ID);
    });

    it('walks tab order in both keyboard directions', () => {
        expect(nextAppTab('manual-rallar', 1)).toBe('topology');
        expect(nextAppTab('manual-rallar', -1)).toBe('rallar-server');
        expect(nextAppTab('rallar-server', 1)).toBe(APP_TABS[0].id);
    });
});
