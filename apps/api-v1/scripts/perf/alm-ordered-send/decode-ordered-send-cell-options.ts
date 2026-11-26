import { Either } from '@shared/resilience/Either.ts';

import {
    ORDERED_SEND_SENDER_RECOVERIES,
    validateOrderedSendShape,
    type OrderedSendSenderRecovery,
    type OrderedSendShape,
    type OrderedSendShapeIssue
} from './validate-ordered-send-shape.ts';

/** Where the run's artifact goes: a file the run names after its start and its shape, or the file `--out` names. */
export type OrderedSendArtifactDestination =
    | { readonly kind: 'named-by-run'; }
    | { readonly kind: 'file'; readonly path: string; };

/** What one invocation of the cell asks for. */
export interface OrderedSendCellOptions {
    readonly shape: OrderedSendShape;
    /** A credential: it goes to the database lifecycle and nowhere else, and is never printed or recorded. */
    readonly databaseUrl: string;
    readonly artifactDestination: OrderedSendArtifactDestination;
}

/** An issue names an option of the command or the place of an argument, and never repeats a text it was given. */
export interface OrderedSendCellOptionIssue {
    readonly code:
        | 'malformed-argument'
        | 'unknown-option'
        | 'repeated-option'
        | 'invalid-number'
        | 'missing-option'
        | 'empty-option'
        | OrderedSendShapeIssue['code'];
    readonly message: string;
}

/** The shape of the reference run. A shape flag the command line leaves out takes its value from here. */
export const ORDERED_SEND_REFERENCE_SHAPE: OrderedSendShape = {
    publishers: 5,
    sendsPerSecond: 2,
    durationS: 20,
    delayMs: 0,
    senderRecovery: 'client-stand-in'
};

interface OptionValuesRead {
    /** The value of each option of the command the arguments give, as the first argument to name it gives it. */
    readonly values: ReadonlyMap<string, string>;
    readonly issues: readonly OrderedSendCellOptionIssue[];
}

interface ShapeDecoded {
    readonly shape: OrderedSendShape;
    readonly issues: readonly OrderedSendCellOptionIssue[];
}

interface NumberDecoded {
    readonly value: number;
    readonly issues: readonly OrderedSendCellOptionIssue[];
}

interface SenderRecoveryDecoded {
    readonly value: OrderedSendSenderRecovery;
    readonly issues: readonly OrderedSendCellOptionIssue[];
}

const OPTION_NAMES = [
    'publishers',
    'sends-per-second',
    'duration-s',
    'delay-ms',
    'sender-recovery',
    'database-url',
    'out'
];
const OPTION_LIST = '--publishers, --sends-per-second, --duration-s, --delay-ms, --sender-recovery, ' +
    '--database-url and --out';
const ONE_TOKEN_OPTION = /^--([^=]+)=(.*)$/s;
const DECIMAL_NUMBER = /^-?\d+(\.\d+)?$/;

/**
 * The options of one invocation, from the arguments after the script's name, or every issue of them at once. Each
 * option is one `--name=value` token. `--database-url` has no default. `--out` may be left out.
 */
export function decodeOrderedSendCellOptions(
    argv: readonly string[]
): Either<readonly OrderedSendCellOptionIssue[], OrderedSendCellOptions> {
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
        artifactDestination: out === undefined ? { kind: 'named-by-run' } : { kind: 'file', path: out }
    });
}

function toOptionValues(argv: readonly string[]): OptionValuesRead {
    const values = new Map<string, string>();
    const issues: OrderedSendCellOptionIssue[] = [];
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
    const publishers = decodeNumber(values, 'publishers', ORDERED_SEND_REFERENCE_SHAPE.publishers);
    const sendsPerSecond = decodeNumber(values, 'sends-per-second', ORDERED_SEND_REFERENCE_SHAPE.sendsPerSecond);
    const durationS = decodeNumber(values, 'duration-s', ORDERED_SEND_REFERENCE_SHAPE.durationS);
    const delayMs = decodeNumber(values, 'delay-ms', ORDERED_SEND_REFERENCE_SHAPE.delayMs);
    const senderRecovery = decodeSenderRecovery(values.get('sender-recovery'));
    const shape = {
        publishers: publishers.value,
        sendsPerSecond: sendsPerSecond.value,
        durationS: durationS.value,
        delayMs: delayMs.value,
        senderRecovery: senderRecovery.value
    };
    return {
        shape,
        issues: [
            ...publishers.issues,
            ...sendsPerSecond.issues,
            ...durationS.issues,
            ...delayMs.issues,
            ...senderRecovery.issues,
            ...validateOrderedSendShape(shape)
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
    const referenceValue = ORDERED_SEND_REFERENCE_SHAPE.senderRecovery;
    if (text === undefined) {
        return { value: referenceValue, issues: [] };
    }
    const value = ORDERED_SEND_SENDER_RECOVERIES.find((senderRecovery) => senderRecovery === text);
    return value === undefined
        ? {
            value: referenceValue,
            issues: [{ code: 'invalid-sender-recovery', message: '--sender-recovery must be none or client-stand-in' }]
        }
        : { value, issues: [] };
}

function validateTextOptions(values: ReadonlyMap<string, string>): readonly OrderedSendCellOptionIssue[] {
    const issues: OrderedSendCellOptionIssue[] = [];
    if (!values.has('database-url')) {
        issues.push({ code: 'missing-option', message: '--database-url is required' });
    }
    for (const name of ['database-url', 'out']) {
        if (values.get(name) === '') {
            issues.push({ code: 'empty-option', message: `--${name} must not be empty` });
        }
    }
    return issues;
}
