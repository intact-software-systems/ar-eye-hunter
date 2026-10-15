import { RALLAR_BLACK_BOX_CONTROL_MAX_FRAME_BYTES } from '@shared-test/rallar-bb-test/control-protocol.ts';
import { assertEquals } from '@std/assert';

import {
    readBlackBoxControlServerConfiguration,
    validateBlackBoxControlServerConfiguration
} from '../src/control-server-configuration.ts';

function readMaxRequestBytesIssues(value: string | undefined): readonly string[] {
    const configuration = readBlackBoxControlServerConfiguration({
        get: (key) => key === 'RALLAR_BLACK_BOX_MAX_REQUEST_BYTES' ? value : undefined
    });
    return validateBlackBoxControlServerConfiguration(configuration);
}

// The agents' control client sends frames up to the shared limit; a lower server limit would close them with 1009.
Deno.test('the control server refuses a request limit below the frame limit its agents send to', () => {
    assertEquals(readMaxRequestBytesIssues(String(RALLAR_BLACK_BOX_CONTROL_MAX_FRAME_BYTES - 1)), [
        `RALLAR_BLACK_BOX_MAX_REQUEST_BYTES must be at least ${RALLAR_BLACK_BOX_CONTROL_MAX_FRAME_BYTES}, the frame limit agents send to; got ${
            RALLAR_BLACK_BOX_CONTROL_MAX_FRAME_BYTES - 1
        }.`
    ]);
    assertEquals(readMaxRequestBytesIssues(undefined), []);
    assertEquals(readMaxRequestBytesIssues(String(RALLAR_BLACK_BOX_CONTROL_MAX_FRAME_BYTES)), []);
    assertEquals(readMaxRequestBytesIssues(String(RALLAR_BLACK_BOX_CONTROL_MAX_FRAME_BYTES * 2)), []);
});

// A zero sweep interval re-arms its timer at once without end, a busy loop.
Deno.test('the control server refuses a zero snapshot flush or deadline sweep interval', () => {
    const issuesFor = (environment: Readonly<Record<string, string>>) =>
        validateBlackBoxControlServerConfiguration(readBlackBoxControlServerConfiguration({ get: (key) => environment[key] }));

    assertEquals(
        issuesFor({ RALLAR_BLACK_BOX_SNAPSHOT_FLUSH_INTERVAL_MS: '0', RALLAR_BLACK_BOX_DEADLINE_SWEEP_INTERVAL_MS: '0' }),
        [
            'RALLAR_BLACK_BOX_SNAPSHOT_FLUSH_INTERVAL_MS must be at least 1; got 0.',
            'RALLAR_BLACK_BOX_DEADLINE_SWEEP_INTERVAL_MS must be at least 1; got 0.'
        ]
    );
    assertEquals(issuesFor({ RALLAR_BLACK_BOX_SNAPSHOT_FLUSH_INTERVAL_MS: '1', RALLAR_BLACK_BOX_DEADLINE_SWEEP_INTERVAL_MS: '1' }), []);
    assertEquals(issuesFor({}), []);
});
