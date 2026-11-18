import { isApiJsonObject, type ApiJsonObject } from '../api/api-json-value.ts';
import { Either } from '../resilience/Either.ts';

/** Drops the share `ratio`, in (0, 1], of the matching frames; which ones depends on the seed alone. */
export interface TransportFaultLoss {
    readonly ratio: number;
    readonly seed: number;
}

/** Delays every matching frame by a whole number of milliseconds within the bounds, drawn from the seed. */
export interface TransportFaultJitter {
    readonly minDelayMs: number;
    readonly maxDelayMs: number;
    readonly seed: number;
}

export type SeededTransportFaultAction =
    | Readonly<{ loss: TransportFaultLoss; }>
    | Readonly<{ jitter: TransportFaultJitter; }>;

function validateFields(record: ApiJsonObject, fields: readonly string[], path: string): readonly string[] {
    return [
        ...Object.keys(record).filter((field) => !fields.includes(field)).map((field) => `${path}.${field} is unknown`),
        ...fields.filter((field) => !Number.isFinite(record[field])).map((field) => `${path}.${field} must be a number`)
    ];
}

function validateSeed(seed: unknown, path: string): readonly string[] {
    return Number.isSafeInteger(seed) ? [] : [`${path}.seed must be an integer`];
}

/** Every issue of a seeded action; none when the action can be injected. */
export function validateSeededTransportFaultAction(action: SeededTransportFaultAction): readonly string[] {
    if ('loss' in action) {
        const { ratio, seed } = action.loss;
        return [
            ...(ratio > 0 && ratio <= 1 ? [] : ['loss.ratio must be above 0 and at most 1']),
            ...validateSeed(seed, 'loss')
        ];
    }
    const { minDelayMs, maxDelayMs, seed } = action.jitter;
    return [
        ...(Number.isSafeInteger(minDelayMs) && minDelayMs >= 0
            ? []
            : ['jitter.minDelayMs must be a whole number of milliseconds, 0 or more']),
        ...(Number.isSafeInteger(maxDelayMs) && maxDelayMs >= minDelayMs
            ? []
            : ['jitter.maxDelayMs must be a whole number of milliseconds, at least jitter.minDelayMs']),
        ...validateSeed(seed, 'jitter')
    ];
}

function decodeLoss(loss: unknown): Either<string, SeededTransportFaultAction> {
    const issues = isApiJsonObject(loss) ? validateFields(loss, ['ratio', 'seed'], 'loss') : ['loss must be an object'];
    if (!isApiJsonObject(loss) || issues.length > 0) {
        return Either.ofLeft(issues.join('; '));
    }
    return Either.ofRight({ loss: { ratio: Number(loss.ratio), seed: Number(loss.seed) } });
}

function decodeJitter(jitter: unknown): Either<string, SeededTransportFaultAction> {
    const fields = ['minDelayMs', 'maxDelayMs', 'seed'];
    const issues = isApiJsonObject(jitter) ? validateFields(jitter, fields, 'jitter') : ['jitter must be an object'];
    if (!isApiJsonObject(jitter) || issues.length > 0) {
        return Either.ofLeft(issues.join('; '));
    }
    return Either.ofRight({
        jitter: {
            minDelayMs: Number(jitter.minDelayMs),
            maxDelayMs: Number(jitter.maxDelayMs),
            seed: Number(jitter.seed)
        }
    });
}

/**
 * Reads a fault action a command names. Right is `null` when the value names neither seeded action, so its
 * caller reads it as another action; left names every issue of a seeded action that cannot be injected.
 */
export function decodeSeededTransportFaultAction(value: unknown): Either<string, SeededTransportFaultAction | null> {
    if (!isApiJsonObject(value) || (!Object.hasOwn(value, 'loss') && !Object.hasOwn(value, 'jitter'))) {
        return Either.ofRight(null);
    }
    if (Object.keys(value).length !== 1) {
        return Either.ofLeft('a seeded fault action names loss or jitter and nothing else');
    }
    const decoded = Object.hasOwn(value, 'loss') ? decodeLoss(value.loss) : decodeJitter(value.jitter);
    return decoded.flatMap(
        (issue) => Either.ofLeft(issue),
        (action) => {
            const issues = validateSeededTransportFaultAction(action);
            return issues.length > 0 ? Either.ofLeft(issues.join('; ')) : Either.ofRight(action);
        }
    );
}
