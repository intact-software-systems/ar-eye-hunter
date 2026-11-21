import { Either } from '@shared/resilience/Either.ts';

const DEFAULT_RUN_LIMIT = 30;

/** GitHub returns at most this many runs in one page, and the ledger reads one page. */
const MAX_RUN_LIMIT = 100;

const REPOSITORY_PATTERN = /^[^/\s]+\/[^/\s]+$/;

export interface AlmLaneLedgerArguments {
    /** How many of the newest workflow runs to read. */
    readonly limit: number;
    /** `owner/name`; null to use the repository `gh` resolves for the working directory. */
    readonly repository: string | null;
}

/** The command line of `npm run alm:lane:ledger`; returns every issue. */
export function decodeAlmLaneLedgerArguments(
    arguments_: readonly string[]
): Either<readonly string[], AlmLaneLedgerArguments> {
    const values = new Map<string, string | undefined>();
    for (let index = 0; index < arguments_.length; index += 2) {
        values.set(arguments_[index] ?? '', arguments_[index + 1]);
    }
    const issues = [...values].flatMap(([name, value]) => validateOption(name, value));
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
        return [`unknown option ${name}; the options are --limit <n> and --repository <owner/name>.`];
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
