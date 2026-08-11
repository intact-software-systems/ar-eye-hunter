import { describe, expect, it } from 'vitest';
import { PSqlOutboundAdmissionBackend } from '@shared-server/postgres/al-runtime/PSqlOutboundAdmissionBackend.ts';

describe('PSqlOutboundAdmissionBackend architecture', () => {
    it('exposes conditional mutation commits without a domain-lock escape hatch', () => {
        const backend = new PSqlOutboundAdmissionBackend({} as never, 'outbound-test');
        expect('lock' in backend).toBe(false);

    });
});
