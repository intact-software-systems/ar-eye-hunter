import { describe, expect, it } from 'vitest';

import { beginsGroupEstablishmentAt, consumesFormationDeadlineAt } from '@shared/api/group-lifecycle/resolve-formation-stage-entry.ts';

describe('formation clocks follow dialing, not held layout stages', () => {
    it.each(
        [
            ['dormant', false],
            ['forming', false],
            ['planned', false],
            ['connecting', true],
            ['active', false],
            ['reconfiguring', false],
            ['reconnecting', true]
        ] as const
    )('%s owns a dialing attempt exactly when needed', (stage, dialing) => {
        expect(beginsGroupEstablishmentAt(stage)).toBe(dialing);
        expect(consumesFormationDeadlineAt(stage)).toBe(dialing);
    });
});
