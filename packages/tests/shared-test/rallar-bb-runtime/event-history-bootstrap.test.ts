import {
    describe,
    expect,
    it
} from 'vitest';

import { resolveRallarBlackBoxBootstrapConfig } from '../../../shared-test/rallar-bb-test/browser-control-agent-config.ts';
import { createDefaultRallarBlackBoxBrowserControlAgent } from '../../../shared-test/rallar-bb-test/browser-control-agent.ts';

describe('event history bootstrap', () => {
    it.each(
        [
            ['', {}, { mode: 'full' }],
            ['?eventHistory=recent&eventHistoryMaxEvents=64', {}, { mode: 'recent', maxEvents: 64 }],
            ['', { VITE_RALLAR_EVENT_HISTORY: 'recent', VITE_RALLAR_EVENT_HISTORY_MAX_EVENTS: '5' }, { mode: 'recent', maxEvents: 5 }],
            ['?eventHistory=full', { VITE_RALLAR_EVENT_HISTORY: 'recent', VITE_RALLAR_EVENT_HISTORY_MAX_EVENTS: '5' }, { mode: 'full' }]
        ] as const
    )('normalizes launch policy from %s', (search, env, policy) => {
        expect(resolveRallarBlackBoxBootstrapConfig(search, env, '')).toMatchObject({ eventHistory: policy, issues: [] });
    });
    it.each([
        'recent',
        'recent&eventHistoryMaxEvents=0',
        'recent&eventHistoryMaxEvents=1.5',
        'full&eventHistoryMaxEvents=2',
        'invalid',
        '&eventHistoryMaxEvents=2',
        'recent&eventHistoryMaxEvents=9007199254740992'
    ])('refuses invalid launch %s before connecting', (selection) => {
        const bootstrap = resolveRallarBlackBoxBootstrapConfig(`?eventHistory=${selection}`, {}, '');
        expect(bootstrap.issues.length).toBeGreaterThan(0);
    });
    it('constructs the persistent simulated agent with the actual launch policy', () => {
        const agent = createDefaultRallarBlackBoxBrowserControlAgent({ search: '?eventHistory=recent&eventHistoryMaxEvents=2', env: {}, hash: '' });
        expect(agent.getSnapshot().state.eventHistory.policy).toEqual({ mode: 'recent', maxEvents: 2 });
    });
});
