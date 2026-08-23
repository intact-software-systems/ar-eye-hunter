import { describe, expect, it } from 'vitest';
import { parseApiV1BlackBoxArgs, toApiV1BlackBoxEnvironment } from '../../shared-test/black-box-runner/api-v1-black-box-run.mts';

describe('api-v1 black-box auth credential environment', () => {
    it('provides the local credential secret for every managed API backend', () => {
        for (const backend of ['postgres', 'pglite-memory', 'pglite-file'] as const) {
            const options = parseApiV1BlackBoxArgs([`--backend=${backend}`]);
            const env = toApiV1BlackBoxEnvironment(options, {});
            expect(env.RALLAR_AUTH_CREDENTIAL_SECRET).toBe(
                'local-api-v1-black-box-auth-credential-secret-v1'
            );
        }
    });
});
