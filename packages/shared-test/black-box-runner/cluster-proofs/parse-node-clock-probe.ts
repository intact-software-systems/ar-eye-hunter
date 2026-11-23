export function parseNodeClockProbe(args: readonly string[]) {
    const [calibrationUrl, calibrationId, enforcementUrl, enforcementId, budget, count, spacing] = args;
    const repeated = args.length === 7;
    if ((!repeated && args.length !== 5) || !calibrationId || !enforcementId) {
        throw new Error(
            'Expected calibrationOrigin calibrationPeerId enforcementOrigin enforcementPeerId budgetMs [count intervalMs].'
        );
    }
    const first = parseOrigin(calibrationUrl);
    const second = parseOrigin(enforcementUrl);
    if (first === second) {
        throw new Error('Supply distinct direct node origins.');
    }
    const budgetMs = parseInteger(budget, 0, Number.MAX_SAFE_INTEGER);
    const observations = repeated ? parseInteger(count, 1, Number.MAX_SAFE_INTEGER) : 1;
    const intervalMs = repeated ? parseInteger(spacing, 1, 2_147_483_647) : 0;
    return { first, second, calibrationId, enforcementId, budgetMs, observations, intervalMs, repeated };
}

function parseInteger(text: string, minimum: number, maximum: number): number {
    const value = Number(text);
    if (!/^\d+$/.test(text) || !Number.isSafeInteger(value) || value < minimum || value > maximum) {
        throw new RangeError(`Expected an integer between ${minimum} and ${maximum}.`);
    }
    return value;
}

function parseOrigin(value: string): string {
    const url = new URL(value);
    if (!['http:', 'https:'].includes(url.protocol) || (value !== url.origin && value !== url.origin + '/')) {
        throw new Error('Supply a direct HTTP(S) origin without credentials, query or path.');
    }
    return url.origin;
}
