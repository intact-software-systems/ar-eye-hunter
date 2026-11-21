import { describe, expect, it } from 'vitest';

import { decodeAlmLaneLedgerArguments } from '@shared-test/rallar-bb-test/conformance/alm/ledger/decode-alm-lane-ledger-arguments.ts';

describe('decodeAlmLaneLedgerArguments', () => {
    it('reads the newest 30 runs of the repository gh resolves when given nothing', () => {
        expect(decodeAlmLaneLedgerArguments([]).right).toEqual({ limit: 30, repository: null });
    });

    it('reads a limit and a repository', () => {
        expect(decodeAlmLaneLedgerArguments(['--limit', '5', '--repository', 'owner/name']).right).toEqual({
            limit: 5,
            repository: 'owner/name'
        });
    });

    it.each([
        [['--limit', '0'], '--limit must be a whole number from 1 to 100; received "0".'],
        [['--limit', '101'], '--limit must be a whole number from 1 to 100; received "101".'],
        [['--limit', 'many'], '--limit must be a whole number from 1 to 100; received "many".'],
        [['--limit'], '--limit needs a value.'],
        [['--repository', 'name'], '--repository must be owner/name; received "name".'],
        [['--branch', 'main'], 'unknown option --branch; the options are --limit <n> and --repository <owner/name>.']
    ])('refuses %j', (arguments_, issue) => {
        expect(decodeAlmLaneLedgerArguments(arguments_).left).toEqual([issue]);
    });
});
