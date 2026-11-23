import { describe, expect, it } from 'vitest';

import committedCauses from '@shared-test/rallar-bb-test/conformance/alm/ledger/alm-lane-flake-causes.json' with { type: 'json' };
import {
    decodeAlmLaneFlakeCauses,
    decodeAlmLaneFlakeCausesText
} from '@shared-test/rallar-bb-test/conformance/alm/ledger/decode-alm-lane-flake-causes.ts';
import type { Either } from '@shared/resilience/Either.ts';

const validEntry = {
    key: 'ws/two-agent/ordered-burst',
    cause: 'The settle window closed before the relay drained its queue.',
    fixedByPullRequest: 851
};

const KEY_FORMS = 'carrier/family/scenarioKey, carrier/family or carrier/run/<run id>, with a known carrier and family';

function toIssues<T>(decoded: Either<readonly string[], T>): readonly string[] {
    return decoded.fold((issues) => issues, () => []);
}

describe('decodeAlmLaneFlakeCauses', () => {
    it('decodes the committed causes file without an issue', () => {
        expect(toIssues(decodeAlmLaneFlakeCauses(committedCauses))).toEqual([]);
    });

    it('decodes a valid entry, with an open cause and a family-wide key', () => {
        const open = { key: 'rtc/four-role', cause: 'The family test timed out after its scenarios.', fixedByPullRequest: null };

        expect(decodeAlmLaneFlakeCauses([validEntry, open]).right).toEqual([validEntry, open]);
    });

    it('refuses a root that is not an array', () => {
        expect(toIssues(decodeAlmLaneFlakeCauses({ causes: [] }))).toEqual([
            'The flake causes must be an array; received an object.'
        ]);
    });

    it.each([
        [{ key: 'ws/two-agent/a', fixedByPullRequest: null }, 'causes[0].cause is missing; expected a non-empty string.'],
        [{ ...validEntry, cause: '' }, 'causes[0].cause is ""; expected a non-empty string.'],
        [{ ...validEntry, key: undefined }, `causes[0].key is missing; expected ${KEY_FORMS}.`],
        [{ ...validEntry, key: 'ws/two-agent/a/' }, `causes[0].key is "ws/two-agent/a/"; expected ${KEY_FORMS}.`],
        [{ ...validEntry, key: 'tcp/two-agent/a' }, `causes[0].key is "tcp/two-agent/a"; expected ${KEY_FORMS}.`],
        [{ ...validEntry, key: 'ws/five-role' }, `causes[0].key is "ws/five-role"; expected ${KEY_FORMS}.`],
        [{ ...validEntry, key: 'ws/run/0' }, `causes[0].key is "ws/run/0"; expected ${KEY_FORMS}.`],
        [{ ...validEntry, key: 'ws/run/x' }, `causes[0].key is "ws/run/x"; expected ${KEY_FORMS}.`],
        [{ scenario: 'ws/two-agent/a', cause: 'x', fixedByPullRequest: null }, `causes[0].key is missing; expected ${KEY_FORMS}.`],
        [{ ...validEntry, fixedByPullRequest: 8.5 }, 'causes[0].fixedByPullRequest is 8.5; expected a positive integer or null.'],
        [{ ...validEntry, fixedByPullRequest: 0 }, 'causes[0].fixedByPullRequest is 0; expected a positive integer or null.'],
        [{ ...validEntry, fixedByPullRequest: '851' }, 'causes[0].fixedByPullRequest is "851"; expected a positive integer or null.'],
        [{ key: 'ws/two-agent/a', cause: 'x' }, 'causes[0].fixedByPullRequest is missing; expected a positive integer or null.'],
        ['a sentence', 'causes[0] is "a sentence"; expected an object.']
    ])('refuses a malformed entry %j', (entry, issue) => {
        expect(toIssues(decodeAlmLaneFlakeCauses([entry]))).toEqual([issue]);
    });

    it('decodes a run key for a red run with nothing to attribute', () => {
        const run = { key: 'rtc-with-ws-fallback/run/44955838821', cause: 'The runner died.', fixedByPullRequest: null };

        expect(decodeAlmLaneFlakeCauses([run]).right).toEqual([run]);
    });

    it('refuses a key named twice', () => {
        expect(toIssues(decodeAlmLaneFlakeCauses([validEntry, { ...validEntry, cause: 'Another reading.' }]))).toEqual([
            'causes names key "ws/two-agent/ordered-burst" more than once.'
        ]);
    });

    it('returns every issue at once', () => {
        expect(toIssues(decodeAlmLaneFlakeCauses([{ key: '', cause: '', fixedByPullRequest: -1 }]))).toHaveLength(3);
    });
});

describe('decodeAlmLaneFlakeCausesText', () => {
    it('decodes the text of a causes file', () => {
        expect(decodeAlmLaneFlakeCausesText(JSON.stringify([validEntry])).right).toEqual([validEntry]);
    });

    it('refuses text that is not JSON as an issue', () => {
        expect(toIssues(decodeAlmLaneFlakeCausesText('[{"scenario":'))).toEqual(['The flake causes file is not JSON.']);
    });

    it('refuses a file that could not be read as an issue', () => {
        expect(toIssues(decodeAlmLaneFlakeCausesText(null))).toEqual(['The flake causes file could not be read.']);
    });

    it('returns the issues of JSON that does not decode', () => {
        expect(toIssues(decodeAlmLaneFlakeCausesText('{}'))).toEqual([
            'The flake causes must be an array; received an object.'
        ]);
    });
});
