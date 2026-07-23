import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { PSqlOutboundAdmissionBackend } from '@shared-server/postgres/al-runtime/PSqlOutboundAdmissionBackend.ts';

describe('PSqlOutboundAdmissionBackend architecture', () => {
    it('exposes conditional mutation commits without a domain-lock escape hatch', () => {
        const backend = new PSqlOutboundAdmissionBackend({} as never, 'outbound-test');
        expect('lock' in backend).toBe(false);

        const source = readFileSync(
            'packages/shared-server/postgres/al-runtime/PSqlOutboundAdmissionBackend.ts',
            'utf8',
        );
        expect(source).not.toMatch(/lockKey|pg_advisory_xact_lock/u);
        expect(source).toContain('PSqlAdmissionMutationCollector');
        expect(source).toContain('collector.apply(collector.mutations())');
    });
});
