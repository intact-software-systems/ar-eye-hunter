import { expect, test } from 'bun:test';

import { RALLAR_BLACK_BOX_CONTROL_MAX_FRAME_BYTES } from '@shared-test/rallar-bb-test/control-protocol.ts';

import {
    readBlackBoxControlServerConfiguration,
    validateBlackBoxControlServerConfiguration
} from '../src/control-server-configuration.ts';

function readMaxRequestBytesIssues(value: string | undefined): readonly string[] {
    const configuration = readBlackBoxControlServerConfiguration({
        RALLAR_BLACK_BOX_MAX_REQUEST_BYTES: value
    });
    return validateBlackBoxControlServerConfiguration(configuration);
}

// The agents' control client sends frames up to the shared limit; a lower server limit would close them with 1009.
test('the control server refuses a request limit below the frame limit its agents send to', () => {
    expect(readMaxRequestBytesIssues(String(RALLAR_BLACK_BOX_CONTROL_MAX_FRAME_BYTES - 1))).toEqual([
        `RALLAR_BLACK_BOX_MAX_REQUEST_BYTES must be at least ${RALLAR_BLACK_BOX_CONTROL_MAX_FRAME_BYTES}, the frame limit agents send to; got ${
            RALLAR_BLACK_BOX_CONTROL_MAX_FRAME_BYTES - 1
        }.`
    ]);
    expect(readMaxRequestBytesIssues(undefined)).toEqual([]);
    expect(readMaxRequestBytesIssues(String(RALLAR_BLACK_BOX_CONTROL_MAX_FRAME_BYTES))).toEqual([]);
    expect(readMaxRequestBytesIssues(String(RALLAR_BLACK_BOX_CONTROL_MAX_FRAME_BYTES * 2))).toEqual([]);
});

// A zero sweep interval re-arms its timer at once without end, a busy loop.
test('the control server refuses a zero snapshot flush or deadline sweep interval', () => {
    const issuesFor = (environment: Readonly<Record<string, string>>) =>
        validateBlackBoxControlServerConfiguration(readBlackBoxControlServerConfiguration(environment));

    expect(issuesFor({ RALLAR_BLACK_BOX_SNAPSHOT_FLUSH_INTERVAL_MS: '0', RALLAR_BLACK_BOX_DEADLINE_SWEEP_INTERVAL_MS: '0' })).toEqual([
        'RALLAR_BLACK_BOX_SNAPSHOT_FLUSH_INTERVAL_MS must be at least 1; got 0.',
        'RALLAR_BLACK_BOX_DEADLINE_SWEEP_INTERVAL_MS must be at least 1; got 0.'
    ]);
    expect(issuesFor({ RALLAR_BLACK_BOX_SNAPSHOT_FLUSH_INTERVAL_MS: '1', RALLAR_BLACK_BOX_DEADLINE_SWEEP_INTERVAL_MS: '1' })).toEqual([]);
    expect(issuesFor({})).toEqual([]);
});

// The automatic sweep keeps the most recently updated runs; unset, it keeps the five a hosted controller deploys with.
test('the control server keeps five runs unless told otherwise, and keeps every run only when told 0', () => {
    const maxRunsFor = (environment: Readonly<Record<string, string>>) => readBlackBoxControlServerConfiguration(environment).retentionMaxRuns;

    expect(maxRunsFor({})).toEqual(5);
    expect(maxRunsFor({ RALLAR_BLACK_BOX_RETENTION_MAX_RUNS: '20' })).toEqual(20);
    expect(maxRunsFor({ RALLAR_BLACK_BOX_RETENTION_MAX_RUNS: '0' })).toEqual(0);
});
