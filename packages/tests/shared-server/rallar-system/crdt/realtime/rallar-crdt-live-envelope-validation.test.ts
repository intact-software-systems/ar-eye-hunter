import { expect, expectTypeOf, it } from 'vitest';

import {
    validateRallarCrdtServerLiveEnvelope,
    type ValidateRallarCrdtServerLiveEnvelopeInput
} from '@shared-server/rallar-system/crdt/realtime/validate-rallar-crdt-server-live-envelope.ts';
import type { RallarCrdtValidationResult } from '@shared/crdt/mod.ts';

it('validates live envelopes through one named-input boundary', () => {
    expectTypeOf(validateRallarCrdtServerLiveEnvelope).toEqualTypeOf<(input: ValidateRallarCrdtServerLiveEnvelopeInput) => RallarCrdtValidationResult>();

    const result = validateRallarCrdtServerLiveEnvelope({
        kind: 'sync-request',
        topicScope: 'app',
        value: undefined,
        context: { topicId: 'app.crdt', typeId: 'app.crdt.sync.request' },
        options: {}
    });

    expect(result.valid).toBe(false);
});
