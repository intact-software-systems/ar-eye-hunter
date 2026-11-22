import { describe, expect, it } from 'vitest';

import committedCauses from '@shared-test/rallar-bb-test/conformance/alm/ledger/alm-lane-flake-causes.json' with { type: 'json' };
import {
    decodeAlmLaneFlakeCauses,
    decodeAlmLaneFlakeCausesText
} from '@shared-test/rallar-bb-test/conformance/alm/ledger/decode-alm-lane-flake-causes.ts';
import type { Either } from '@shared/resilience/Either.ts';

const validEntry = {
    scenario: 'ws/two-agent/ordered-burst',
    cause: 'The settle window closed before the relay drained its queue.',
    fixedByPullRequest: 851
};

function toIssues<T>(decoded: Either<readonly string[], T>): readonly string[] {
    return decoded.fold((issues) => issues, () => []);
}

describe('decodeAlmLaneFlakeCauses', () => {
    it('decodes the committed causes file to an empty list', () => {
        expect(decodeAlmLaneFlakeCauses(committedCauses).right).toEqual([]);
    });

    it('decodes a valid entry, with an open cause and a family-wide key', () => {
        const open = { scenario: 'rtc/four-role', cause: 'The family test timed out after its scenarios.', fixedByPullRequest: null };

        expect(decodeAlmLaneFlakeCauses([validEntry, open]).right).toEqual([validEntry, open]);
    });

    it('refuses a root that is not an array', () => {
        expect(toIssues(decodeAlmLaneFlakeCauses({ causes: [] }))).toEqual([
            'The flake causes must be an array; received an object.'
        ]);
    });

    it.each([
        [{ scenario: 'ws/two-agent/a', fixedByPullRequest: null }, 'causes[0].cause is missing; expected a non-empty string.'],
        [{ ...validEntry, cause: '' }, 'causes[0].cause is ""; expected a non-empty string.'],
        [{ ...validEntry, scenario: undefined }, 'causes[0].scenario is missing; expected a non-empty string.'],
        [{ ...validEntry, fixedByPullRequest: 8.5 }, 'causes[0].fixedByPullRequest is 8.5; expected a positive integer or null.'],
        [{ ...validEntry, fixedByPullRequest: 0 }, 'causes[0].fixedByPullRequest is 0; expected a positive integer or null.'],
        [{ ...validEntry, fixedByPullRequest: '851' }, 'causes[0].fixedByPullRequest is "851"; expected a positive integer or null.'],
        [{ scenario: 'ws/two-agent/a', cause: 'x' }, 'causes[0].fixedByPullRequest is missing; expected a positive integer or null.'],
        ['a sentence', 'causes[0] is "a sentence"; expected an object.']
    ])('refuses a malformed entry %j', (entry, issue) => {
        expect(toIssues(decodeAlmLaneFlakeCauses([entry]))).toEqual([issue]);
    });

    it('refuses a scenario named twice', () => {
        expect(toIssues(decodeAlmLaneFlakeCauses([validEntry, { ...validEntry, cause: 'Another reading.' }]))).toEqual([
            'causes names scenario "ws/two-agent/ordered-burst" more than once.'
        ]);
    });

    it('returns every issue at once', () => {
        expect(toIssues(decodeAlmLaneFlakeCauses([{ scenario: '', cause: '', fixedByPullRequest: -1 }]))).toHaveLength(3);
    });
});

describe('decodeAlmLaneFlakeCausesText', () => {
    it('decodes the text of a causes file', () => {
        expect(decodeAlmLaneFlakeCausesText(JSON.stringify([validEntry])).right).toEqual([validEntry]);
    });

    it('refuses text that is not JSON as an issue', () => {
        expect(toIssues(decodeAlmLaneFlakeCausesText('[{"scenario":'))).toEqual(['The flake causes file is not JSON.']);
    });

    it('returns the issues of JSON that does not decode', () => {
        expect(toIssues(decodeAlmLaneFlakeCausesText('{}'))).toEqual([
            'The flake causes must be an array; received an object.'
        ]);
    });
});
