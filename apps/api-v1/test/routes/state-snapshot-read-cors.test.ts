import assert from 'node:assert/strict';

import { STATE_SNAPSHOT_READ_EXPOSED_HEADERS } from '../../src/routes/state-snapshot-read/state-snapshot-read-exposed-headers.ts';

Deno.test('browser CORS exposure includes every state snapshot response header', () => {
    assert.deepEqual(STATE_SNAPSHOT_READ_EXPOSED_HEADERS, [
        'Rallar-State-Source',
        'Rallar-State-Revision',
        'Rallar-Group-Revision',
        'Rallar-Presence-Revision'
    ]);
});
