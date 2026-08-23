import { PSqlOutboundAdmissionBackend } from '@shared-server/al-runtime/postgres/p-sql-outbound-admission-backend.ts';
import { describe, expect, it } from 'vitest';

describe('PSqlOutboundAdmissionBackend architecture', () => {
    it('exposes conditional mutation commits without a domain-lock escape hatch', () => {
        const backend = new PSqlOutboundAdmissionBackend({} as never, 'outbound-test');
        expect('lock' in backend).toBe(false);
    });
});
