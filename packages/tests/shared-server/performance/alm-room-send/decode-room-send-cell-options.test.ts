import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import {
    decodeRoomSendCellOptions,
    ROOM_SEND_REFERENCE_SHAPE,
    type RoomSendCellOptionIssue,
    type RoomSendCellOptions
} from '../../../../../apps/api-v1/scripts/perf/alm-room-send/decode-room-send-cell-options.ts';

const DATABASE_URL = 'postgres://app:s3cret-pw@db.internal:5432/alm_cell_run?sslmode=require';

function readOptions(argv: readonly string[]): RoomSendCellOptions | undefined {
    return decodeRoomSendCellOptions(argv).foldRight((options) => options);
}

function readIssues(argv: readonly string[]): readonly RoomSendCellOptionIssue[] | undefined {
    return decodeRoomSendCellOptions(argv).foldLeft((issues) => issues);
}

describe('decodeRoomSendCellOptions', () => {
    it('decodes the reference invocation, and gives a flag left out the value the reference invocation gives it', () => {
        const reference = {
            shape: {
                publishers: 5,
                sendsPerSecond: 2,
                durationS: 20,
                delayMs: 0,
                senderRecovery: 'client-stand-in',
                applicationPoolMaxConnections: 5
            },
            databaseUrl: DATABASE_URL,
            artifactDestination: { kind: 'named-by-run' }
        };

        expect(readOptions([
            '--publishers=5',
            '--sends-per-second=2',
            '--duration-s=20',
            '--delay-ms=0',
            '--sender-recovery=client-stand-in',
            '--application-pool=5',
            `--database-url=${DATABASE_URL}`
        ])).toMatchObject(reference);
        expect(readOptions([`--database-url=${DATABASE_URL}`])).toMatchObject(reference);
        expect(ROOM_SEND_REFERENCE_SHAPE).toEqual(reference.shape);
    });

    it('gives an application pool left out the size the API\'s own defaults give it', () => {
        const apiV1Defaults = JSON.parse(
            readFileSync(
                new URL('../../../../../apps/api-v1/resources/configuration/defaults-config.json', import.meta.url),
                'utf8'
            )
        );

        expect(readOptions([`--database-url=${DATABASE_URL}`])?.shape.applicationPoolMaxConnections)
            .toBe(apiV1Defaults.database.applicationPool.maxConnections);
    });

    it('decodes each flag it is given, in any order, and a file to write the artifact to', () => {
        expect(readOptions([
            '--out=tmp/perf/alm-room-send/one-track.json',
            `--database-url=${DATABASE_URL}`,
            '--delay-ms=5',
            '--duration-s=45',
            '--sends-per-second=10',
            '--sender-recovery=none',
            '--application-pool=10',
            '--publishers=1'
        ])).toEqual({
            shape: {
                publishers: 1,
                sendsPerSecond: 10,
                durationS: 45,
                delayMs: 5,
                senderRecovery: 'none',
                applicationPoolMaxConnections: 10
            },
            databaseUrl: DATABASE_URL,
            artifactDestination: { kind: 'file', path: 'tmp/perf/alm-room-send/one-track.json' },
            givenOptions: {
                out: 'tmp/perf/alm-room-send/one-track.json',
                'delay-ms': '5',
                'duration-s': '45',
                'sends-per-second': '10',
                'sender-recovery': 'none',
                'application-pool': '10',
                publishers: '1'
            }
        });
    });

    it('keeps the options as the command line gave them, in its order, without the database URL and without a default', () => {
        const options = readOptions([`--database-url=${DATABASE_URL}`, '--delay-ms=05', '--publishers=5']);

        expect(options?.givenOptions).toEqual({ 'delay-ms': '05', publishers: '5' });
        expect(Object.keys(options?.givenOptions ?? {})).toEqual(['delay-ms', 'publishers']);
        expect(readOptions([`--database-url=${DATABASE_URL}`])?.givenOptions).toEqual({});
    });

    it('refuses an invocation that names no database, with no default to fall back on', () => {
        expect(readIssues(['--publishers=5', '--sends-per-second=2', '--duration-s=20', '--delay-ms=0'])).toEqual([
            { code: 'missing-option', message: '--database-url is required' }
        ]);
    });

    it('returns every issue of an invocation at once', () => {
        expect(readIssues([
            'stray',
            '--publishers=many',
            '--verbose=1',
            '--delay-ms=-1',
            '--delay-ms=5',
            '--duration-s',
            '--sends-per-second=0',
            '--sender-recovery=browser',
            '--out='
        ])).toEqual([
            { code: 'malformed-argument', message: 'argument 1 is not one --name=value token' },
            {
                code: 'unknown-option',
                message: 'argument 3 names no option of this command: it takes --publishers, --sends-per-second, ' +
                    '--duration-s, --delay-ms, --sender-recovery, --application-pool, --database-url and --out'
            },
            { code: 'repeated-option', message: '--delay-ms is given more than once' },
            { code: 'malformed-argument', message: 'argument 6 is not one --name=value token' },
            { code: 'invalid-number', message: '--publishers must be a number written in digits' },
            { code: 'invalid-sender-recovery', message: '--sender-recovery must be none or client-stand-in' },
            {
                code: 'invalid-sends-per-second',
                message: 'sendsPerSecond must be a whole number of at least 1; received 0'
            },
            { code: 'invalid-delay-ms', message: 'delayMs must be a whole number of at least 0; received -1' },
            { code: 'missing-option', message: '--database-url is required' },
            { code: 'empty-option', message: '--out must not be empty' }
        ]);
    });

    it.each([
        ['a fraction', '--duration-s=2.5', 'invalid-duration-s'],
        ['more publishers than the room has sessions', '--publishers=16', 'invalid-publishers'],
        ['an application pool of no connection', '--application-pool=0', 'invalid-application-pool'],
        ['an exponent', '--sends-per-second=1e1', 'invalid-number'],
        ['no value', '--delay-ms=', 'invalid-number']
    ])('refuses %s', (_name, argument, code) => {
        expect(readIssues([`--database-url=${DATABASE_URL}`, argument])?.map((issue) => issue.code)).toEqual([code]);
    });

    it('refuses an empty database URL', () => {
        expect(readIssues(['--database-url='])).toEqual([
            { code: 'empty-option', message: '--database-url must not be empty' }
        ]);
    });

    it.each([
        ['a text that is no URL', 'not a url s3cr3t'],
        ['a URL that lost the colon of its scheme', 'postgres//user:pw@host/db'],
        ['a URL of another scheme', 'https://user:pw@host/db'],
        ['a path', '/var/run/postgresql/s3cr3t']
    ])('refuses %s for the database URL, and repeats nothing of it', (_name, databaseUrl) => {
        const issues = readIssues([`--database-url=${databaseUrl}`]);

        expect(issues).toEqual([
            { code: 'invalid-database-url', message: '--database-url must be a postgres:// or postgresql:// URL' }
        ]);
    });

    it('refuses a database URL that holds whitespace, a quote, a backtick or an angle bracket unencoded, and repeats nothing of it', () => {
        const unencoded = [
            'postgres://app:s3cr et@db.internal:5432/alm_cell_run',
            'postgres://app:s3cr\tet@db.internal:5432/alm_cell_run',
            'postgres://app:s3cr"et@db.internal:5432/alm_cell_run',
            'postgres://app:s3cr\'et@db.internal:5432/alm_cell_run',
            'postgres://app:s3cr`et@db.internal:5432/alm_cell_run',
            'postgres://app:s3cr<et@db.internal:5432/alm_cell_run',
            'postgresql://app:s3cr>et@db.internal:5432/alm_cell_run',
            'postgresql://app:s3cret@db.internal:5432/alm_cell_run?options=-c search_path=cell'
        ];

        for (const databaseUrl of unencoded) {
            expect(readIssues([`--database-url=${databaseUrl}`])).toEqual([
                {
                    code: 'invalid-database-url',
                    message: '--database-url must hold no whitespace, quote, backtick or angle bracket: percent-encode each'
                }
            ]);
        }
        const encoded = 'postgres://app:s3cr%20%22%27%60%3C%3Eet@db.internal:5432/alm_cell_run';
        expect(readOptions([`--database-url=${encoded}`])?.databaseUrl).toBe(encoded);
    });

    it('takes a database URL of either PostgreSQL scheme as it is', () => {
        const postgresql = 'postgresql://app:s3cret-pw@db.internal:5432/alm_cell_run';

        expect(readOptions([`--database-url=${DATABASE_URL}`])?.databaseUrl).toBe(DATABASE_URL);
        expect(readOptions([`--database-url=${postgresql}`])?.databaseUrl).toBe(postgresql);
    });

    it('never repeats the database URL, or any other text of the command line, in an issue', () => {
        const issues = readIssues([
            DATABASE_URL,
            `--databse-url=${DATABASE_URL}`,
            `--${DATABASE_URL}`,
            `--publishers=${DATABASE_URL}`,
            `--sender-recovery=${DATABASE_URL}`,
            `--database-url=${DATABASE_URL}`,
            `--database-url=${DATABASE_URL}`,
            `--out=`
        ]);

        expect(issues?.map((issue) => issue.code)).toEqual([
            'malformed-argument',
            'unknown-option',
            'unknown-option',
            'repeated-option',
            'invalid-number',
            'invalid-sender-recovery',
            'empty-option'
        ]);
        const issueText = JSON.stringify(issues);
        for (const secret of ['postgres:', 's3cret-pw', 'db.internal', 'alm_cell_run', 'sslmode', 'databse']) {
            expect(issueText).not.toContain(secret);
        }
    });
});
