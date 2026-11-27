import { describe, expect, it } from 'vitest';

import { runAlmRoomSendCell } from '../../../../../apps/api-v1/scripts/perf/alm-room-send/alm-room-send-cell.ts';

/** No server answers at this address: a run that tried to open it would fail, where one refused first never tries. */
const DATABASE_URL = 'postgres://app:s3cret-pw@db.invalid:5432/alm_cell_run';

describe('runAlmRoomSendCell', () => {
    it('refuses an invocation with every issue of its options before it opens a database, and never repeats the database URL', async () => {
        const outcome = await runAlmRoomSendCell([
            `--database-url=${DATABASE_URL}`,
            '--publishers=many',
            '--application-pool=0'
        ]);

        expect(outcome.right).toBeUndefined();
        expect(outcome.left).toEqual([
            { code: 'missing-option', message: '--ordering is required' },
            { code: 'invalid-number', message: '--publishers must be a number written in digits' },
            {
                code: 'invalid-application-pool',
                message: 'applicationPoolMaxConnections must be a whole number of at least 1; received 0'
            }
        ]);
        expect(JSON.stringify(outcome.left)).not.toContain('s3cret-pw');
    });
});
