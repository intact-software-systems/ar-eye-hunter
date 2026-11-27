import { Either } from '@shared/resilience/Either.ts';

import { ROOM_SEND_API_V1_DEFAULTS } from './room-send-api-v1-defaults.ts';
import {
    ROOM_SEND_SENDER_RECOVERIES,
    validateRoomSendShape,
    type RoomSendSenderRecovery,
    type RoomSendShape,
    type RoomSendShapeIssue
} from './validate-room-send-shape.ts';

/** Where the run's artifact goes: a file the run names after its start and its shape, or the file `--out` names. */
export type RoomSendArtifactDestination =
    | { readonly kind: 'named-by-run'; }
    | { readonly kind: 'file'; readonly path: string; };

/** What one invocation of the cell asks for. */
export interface RoomSendCellOptions {
    readonly shape: RoomSendShape;
    /** A credential: it goes to the database lifecycle and nowhere else, and is never printed or recorded. */
    readonly databaseUrl: string;
    readonly artifactDestination: RoomSendArtifactDestination;
    /**
     * Each option the command line gave, under its name and as the text it was given, in the order given, without
     * `--database-url`: what tells a value the invocation chose from one the reference shape supplied.
     */
    readonly givenOptions: Readonly<Record<string, string>>;
}

/** An issue names an option of the command or the place of an argument, and never repeats a text it was given. */
export interface RoomSendCellOptionIssue {
    readonly code:
        | 'malformed-argument'
        | 'unknown-option'
        | 'repeated-option'
        | 'invalid-number'
        | 'missing-option'
        | 'empty-option'
        | 'invalid-database-url'
        | RoomSendShapeIssue['code'];
    readonly message: string;
}

/**
 * The shape of the reference run. A shape flag the command line leaves out takes its value from here; the
 * application pool's is the API's own default, so a run that names no pool has the pool an API instance starts with.
 */
export const ROOM_SEND_REFERENCE_SHAPE: RoomSendShape = {
    ordering: 'ordering-key',
    publishers: 5,
    sendsPerSecond: 2,
    durationS: 20,
    delayMs: 0,
    senderRecovery: 'client-stand-in',
    applicationPoolMaxConnections: ROOM_SEND_API_V1_DEFAULTS.applicationPoolMaxConnections
};

interface OptionValuesRead {
    /** The value of each option of the command the arguments give, as the first argument to name it gives it. */
    readonly values: ReadonlyMap<string, string>;
    readonly issues: readonly RoomSendCellOptionIssue[];
}

interface ShapeDecoded {
    readonly shape: RoomSendShape;
    readonly issues: readonly RoomSendCellOptionIssue[];
}

interface NumberDecoded {
    readonly value: number;
    readonly issues: readonly RoomSendCellOptionIssue[];
}

interface SenderRecoveryDecoded {
    readonly value: RoomSendSenderRecovery;
    readonly issues: readonly RoomSendCellOptionIssue[];
}

const OPTION_NAMES = [
    'publishers',
    'sends-per-second',
    'duration-s',
    'delay-ms',
    'sender-recovery',
    'application-pool',
    'database-url',
    'out'
];
const OPTION_LIST = '--publishers, --sends-per-second, --duration-s, --delay-ms, --sender-recovery, ' +
    '--application-pool, --database-url and --out';
const ONE_TOKEN_OPTION = /^--([^=]+)=(.*)$/s;
const DATABASE_URL_PROTOCOLS = ['postgres:', 'postgresql:'];
/**
 * What a URL must percent-encode and the URL parser takes as it is. The text removed from an error's message as a URL
 * ends at the first of them (`toRoomSendThrownError`), so the rest of a password that held one would be printed.
 */
const UNENCODED_URL_CHARACTER = /[\s"'`<>]/;
const DECIMAL_NUMBER = /^-?\d+(\.\d+)?$/;

/**
 * The options of one invocation, from the arguments after the script's name, or every issue of them at once. Each
 * option is one `--name=value` token. `--database-url` has no default and must be a `postgres:` or `postgresql:` URL
 * with its whitespace, quotes, backticks and angle brackets percent-encoded. `--out` may be left out.
 */
export function decodeRoomSendCellOptions(
    argv: readonly string[]
): Either<readonly RoomSendCellOptionIssue[], RoomSendCellOptions> {
    const read = toOptionValues(argv);
    const decoded = decodeShape(read.values);
    const databaseUrl = read.values.get('database-url');
    const out = read.values.get('out');

    const issues = [...read.issues, ...decoded.issues, ...validateTextOptions(read.values)];
    if (issues.length > 0 || databaseUrl === undefined) {
        return Either.ofLeft(issues);
    }
    return Either.ofRight({
        shape: decoded.shape,
        databaseUrl,
        artifactDestination: out === undefined ? { kind: 'named-by-run' } : { kind: 'file', path: out },
        givenOptions: Object.fromEntries([...read.values].filter(([name]) => name !== 'database-url'))
    });
}

function toOptionValues(argv: readonly string[]): OptionValuesRead {
    const values = new Map<string, string>();
    const issues: RoomSendCellOptionIssue[] = [];
    argv.forEach((argument, index) => {
        const token = ONE_TOKEN_OPTION.exec(argument);
        if (token === null) {
            issues.push({
                code: 'malformed-argument',
                message: `argument ${index + 1} is not one --name=value token`
            });
            return;
        }
        const [, name, value] = token;
        if (!OPTION_NAMES.includes(name)) {
            issues.push({
                code: 'unknown-option',
                message: `argument ${index + 1} names no option of this command: it takes ${OPTION_LIST}`
            });
        }
        else if (values.has(name)) {
            issues.push({ code: 'repeated-option', message: `--${name} is given more than once` });
        }
        else {
            values.set(name, value);
        }
    });
    return { values, issues };
}

/** A flag that does not decode is an issue of its own, and the shape is then checked with the reference value in its place. */
function decodeShape(values: ReadonlyMap<string, string>): ShapeDecoded {
    const publishers = decodeNumber(values, 'publishers', ROOM_SEND_REFERENCE_SHAPE.publishers);
    const sendsPerSecond = decodeNumber(values, 'sends-per-second', ROOM_SEND_REFERENCE_SHAPE.sendsPerSecond);
    const durationS = decodeNumber(values, 'duration-s', ROOM_SEND_REFERENCE_SHAPE.durationS);
    const delayMs = decodeNumber(values, 'delay-ms', ROOM_SEND_REFERENCE_SHAPE.delayMs);
    const senderRecovery = decodeSenderRecovery(values.get('sender-recovery'));
    const applicationPool = decodeNumber(
        values,
        'application-pool',
        ROOM_SEND_REFERENCE_SHAPE.applicationPoolMaxConnections
    );
    const shape = {
        ordering: ROOM_SEND_REFERENCE_SHAPE.ordering,
        publishers: publishers.value,
        sendsPerSecond: sendsPerSecond.value,
        durationS: durationS.value,
        delayMs: delayMs.value,
        senderRecovery: senderRecovery.value,
        applicationPoolMaxConnections: applicationPool.value
    };
    return {
        shape,
        issues: [
            ...publishers.issues,
            ...sendsPerSecond.issues,
            ...durationS.issues,
            ...delayMs.issues,
            ...senderRecovery.issues,
            ...applicationPool.issues,
            ...validateRoomSendShape(shape)
        ]
    };
}

function decodeNumber(values: ReadonlyMap<string, string>, name: string, referenceValue: number): NumberDecoded {
    const text = values.get(name);
    if (text === undefined) {
        return { value: referenceValue, issues: [] };
    }
    return DECIMAL_NUMBER.test(text)
        ? { value: Number(text), issues: [] }
        : {
            value: referenceValue,
            issues: [{ code: 'invalid-number', message: `--${name} must be a number written in digits` }]
        };
}

function decodeSenderRecovery(text: string | undefined): SenderRecoveryDecoded {
    const referenceValue = ROOM_SEND_REFERENCE_SHAPE.senderRecovery;
    if (text === undefined) {
        return { value: referenceValue, issues: [] };
    }
    const value = ROOM_SEND_SENDER_RECOVERIES.find((senderRecovery) => senderRecovery === text);
    return value === undefined
        ? {
            value: referenceValue,
            issues: [{ code: 'invalid-sender-recovery', message: '--sender-recovery must be none or client-stand-in' }]
        }
        : { value, issues: [] };
}

function validateTextOptions(values: ReadonlyMap<string, string>): readonly RoomSendCellOptionIssue[] {
    const issues: RoomSendCellOptionIssue[] = [];
    if (!values.has('database-url')) {
        issues.push({ code: 'missing-option', message: '--database-url is required' });
    }
    for (const name of ['database-url', 'out']) {
        if (values.get(name) === '') {
            issues.push({ code: 'empty-option', message: `--${name} must not be empty` });
        }
    }
    const databaseUrl = values.get('database-url');
    if (databaseUrl !== undefined && databaseUrl !== '') {
        issues.push(...validateDatabaseUrl(databaseUrl));
    }
    return issues;
}

/** A text that is no PostgreSQL URL has that one issue: what it fails to encode is read only of a URL. */
function validateDatabaseUrl(databaseUrl: string): readonly RoomSendCellOptionIssue[] {
    if (!isPostgresUrl(databaseUrl)) {
        return [{ code: 'invalid-database-url', message: '--database-url must be a postgres:// or postgresql:// URL' }];
    }
    return UNENCODED_URL_CHARACTER.test(databaseUrl)
        ? [{
            code: 'invalid-database-url',
            message: '--database-url must hold no whitespace, quote, backtick or angle bracket: percent-encode each'
        }]
        : [];
}

/**
 * A text the database lifecycle can parse. One it cannot would be thrown back by the URL parser with the text in the
 * error, and the text may hold a password.
 */
function isPostgresUrl(text: string): boolean {
    return URL.canParse(text) && DATABASE_URL_PROTOCOLS.includes(new URL(text).protocol);
}
