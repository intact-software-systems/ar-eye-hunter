import { describe, expect, it } from 'vitest';
import { parseApiV1BlackBoxArgs, toApiV1BlackBoxEnvironment } from '../../shared-test/black-box-runner/api-v1-black-box-run.mts';

describe('api-v1 black-box PGlite timezone fixture', () => {
    it('forces UTC only for pglite-memory and preserves the Postgres process timezone', () => {
        const callerEnvironment = { TZ: 'Asia/Tokyo' };
        const memoryEnvironment = toApiV1BlackBoxEnvironment(
            parseApiV1BlackBoxArgs(['--backend=pglite-memory']),
            callerEnvironment
        );
        const postgresEnvironment = toApiV1BlackBoxEnvironment(
            parseApiV1BlackBoxArgs(['--backend=postgres']),
            callerEnvironment
        );

        expect(memoryEnvironment.TZ).toBe('UTC');
        expect(postgresEnvironment.TZ).toBe('Asia/Tokyo');
    });
});
