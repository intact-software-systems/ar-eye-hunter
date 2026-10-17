import { describe, expect, it } from 'vitest';

import {
    CONTROL_RUN_COMPLETION_FILE_NAME,
    decodeControlRunCompletion,
    type ControlRunCompletion
} from '@shared-test/rallar-bb-test/control/control-run-completion.ts';

const completion: ControlRunCompletion = {
    completedAtEpochMs: 1_700_000_000_000,
    retentionRevision: 42,
    counts: { commands: 4, results: 4, events: 24, stats: 0, reports: 1, heartbeats: 12 },
    file: { path: `runs/run-1/${CONTROL_RUN_COMPLETION_FILE_NAME}`, bytes: 123_456, writtenAtEpochMs: 1_700_000_000_500, state: 'present' }
};

describe('control run completion contract', () => {
    it('decodes the index entry a control server persisted for a completed run', () => {
        expect(decodeControlRunCompletion(JSON.parse(JSON.stringify(completion))).right).toEqual(completion);
        expect(decodeControlRunCompletion({ ...completion, file: { ...completion.file, state: 'missing' } }).right?.file.state).toBe('missing');
    });

    it('rejects an entry whose file reference, counts or revision is missing or malformed', () => {
        expect(decodeControlRunCompletion(undefined).left).toBe('completion must be a JSON object');
        expect(decodeControlRunCompletion({ ...completion, retentionRevision: '42' }).left).toBe(
            'completion.retentionRevision must be a finite number'
        );
        expect(decodeControlRunCompletion({ ...completion, counts: { ...completion.counts, events: undefined } }).left).toBe(
            'completion.counts.events must be a finite number'
        );
        expect(decodeControlRunCompletion({ ...completion, file: { ...completion.file, path: '' } }).left).toBe(
            'completion.file.path must be a non-empty string'
        );
        expect(decodeControlRunCompletion({ ...completion, file: { ...completion.file, state: 'gone' } }).left).toBe(
            'completion.file.state must be present or missing'
        );
    });
});
