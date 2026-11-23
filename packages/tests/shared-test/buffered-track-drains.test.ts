import { describe, expect, it, vi } from 'vitest';

import { createAlmConformanceRecipes } from '@shared-test/rallar-bb-test/conformance/alm/create-alm-conformance-recipes.ts';

import { toConformanceInput } from './alm-conformance-test-input.ts';

// A held-send builder that copies the send it wraps, as a later refactor of it may.
vi.mock('@shared-test/rallar-bb-test/conformance/alm/alm-conformance-fault-commands.ts', async (importOriginal) => {
    const original = await importOriginal<typeof import('@shared-test/rallar-bb-test/conformance/alm/alm-conformance-fault-commands.ts')>();
    return {
        ...original,
        toHeldSendCommands: (...[step, send]: Parameters<typeof original.toHeldSendCommands>) =>
            original.toHeldSendCommands(step, send.map((command) => ({ ...command })))
    };
});

describe('buffered-track-drains', () => {
    it('refuses to size the track\'s lifetime when the held block no longer carries seq 2\'s own send', () => {
        expect(() => createAlmConformanceRecipes(toConformanceInput('ws'))).toThrow(/seq 2/);
    });
});
