import { Either } from '@shared/resilience/Either.ts';

const DEFAULT_RUN_LIMIT = 30;

/** GitHub returns at most this many runs in one page, and the ledger reads one page of each kind. */
const MAX_RUN_LIMIT = 100;

const ALM_LANE_LEDGER_USAGE = '--limit <n> (the main push runs to read, and the bound on pull-request and dispatched' +
    ' runs) and --repository <owner/name>';

const REPOSITORY_PATTERN = /^[^/\s]+\/[^/\s]+$/;

export interface AlmLaneLedgerArguments {
    /** How many of the newest main push runs to read; also the bound on pull-request and dispatched runs. */
    readonly limit: number;
    /** `owner/name`; null to use the repository `gh` resolves for the working directory. */
    readonly repository: string | null;
}

/** The command line of `npm run alm:lane:ledger`; returns every issue. */
export function decodeAlmLaneLedgerArguments(
    arguments_: readonly string[]
): Either<readonly string[], AlmLaneLedgerArguments> {
    const options = Array.from(
        { length: Math.ceil(arguments_.length / 2) },
        (_, index): readonly [string, string | undefined] => [arguments_[index * 2] ?? '', arguments_[index * 2 + 1]]
    );
    const values = new Map(options);
    const names = options.map(([name]) => name);
    const issues = [
        ...options.flatMap(([name, value]) => validateOption(name, value)),
        ...[...new Set(names.filter((name, index) => names.indexOf(name) !== index))]
            .map((name) => `${name} is given more than once.`)
    ];
    if (issues.length > 0) {
        return Either.ofLeft(issues);
    }
    return Either.ofRight({
        limit: Number(values.get('--limit') ?? DEFAULT_RUN_LIMIT),
        repository: values.get('--repository') ?? null
    });
}

function validateOption(name: string, value: string | undefined): readonly string[] {
    if (name !== '--limit' && name !== '--repository') {
        return [`unknown option ${name}; the options are ${ALM_LANE_LEDGER_USAGE}.`];
    }
    if (value === undefined) {
        return [`${name} needs a value.`];
    }
    if (name === '--repository') {
        return REPOSITORY_PATTERN.test(value)
            ? []
            : [`--repository must be owner/name; received ${JSON.stringify(value)}.`];
    }
    const limit = Number(value);
    return /^\d+$/.test(value) && limit >= 1 && limit <= MAX_RUN_LIMIT
        ? []
        : [`--limit must be a whole number from 1 to ${MAX_RUN_LIMIT}; received ${JSON.stringify(value)}.`];
}
