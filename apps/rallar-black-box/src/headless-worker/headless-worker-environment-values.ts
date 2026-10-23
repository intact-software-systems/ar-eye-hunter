export type HeadlessWorkerEnvironment = Readonly<Record<string, string | undefined>>;

export interface ReadOptionalEnvironmentCoordinateInput {
    readonly env: HeadlessWorkerEnvironment;
    readonly primaryKey: string;
    readonly fallbackKey: string;
    readonly min: number;
    readonly max: number;
}

export function readEnvironmentString(env: HeadlessWorkerEnvironment, key: string): string | undefined {
    const value = env[key]?.trim();
    return value && value.length > 0 ? value : undefined;
}

export function readRequiredEnvironmentString(env: HeadlessWorkerEnvironment, key: string): string {
    const value = readEnvironmentString(env, key);
    if (!value) {
        throw new Error(`Missing required headless worker env: ${key}`);
    }
    return value;
}

export function readEnvironmentList(env: HeadlessWorkerEnvironment, key: string): readonly string[] | undefined {
    const value = readEnvironmentString(env, key);
    if (!value) {
        return undefined;
    }
    const entries = value.split(',').map((entry) => entry.trim()).filter(Boolean);
    return entries.length > 0 ? entries : undefined;
}

export function readEnvironmentPositiveInteger(env: HeadlessWorkerEnvironment, key: string, fallback: number): number {
    return readOptionalEnvironmentPositiveInteger(env, key) ?? fallback;
}

export function readOptionalEnvironmentPositiveInteger(
    env: HeadlessWorkerEnvironment,
    key: string
): number | undefined {
    const raw = readEnvironmentString(env, key);
    if (!raw) {
        return undefined;
    }

    const parsed = Number.parseInt(raw, 10);
    if (!Number.isInteger(parsed) || parsed < 1) {
        throw new Error(`${key} must be a positive integer. Received: ${raw}`);
    }
    return parsed;
}

export function readOptionalEnvironmentCoordinate(input: ReadOptionalEnvironmentCoordinateInput): number | undefined {
    const { env, primaryKey, fallbackKey, min, max } = input;
    const raw = readEnvironmentString(env, primaryKey) ?? readEnvironmentString(env, fallbackKey);
    if (!raw) {
        return undefined;
    }

    const parsed = /^[+-]?(?:(?:\d+(?:\.\d*)?)|(?:\.\d+))(?:e[+-]?\d+)?$/i.test(raw) ? Number(raw) : Number.NaN;
    if (!Number.isFinite(parsed) || parsed < min || parsed > max) {
        throw new Error(`${primaryKey} must be between ${min} and ${max}. Received: ${raw}`);
    }
    return parsed;
}

export function readEnvironmentBoolean(env: HeadlessWorkerEnvironment, key: string, fallback: boolean): boolean {
    const raw = readEnvironmentString(env, key);
    if (!raw) {
        return fallback;
    }
    const normalized = raw.toLowerCase();
    return normalized === '1' ||
        normalized === 'true' ||
        normalized === 'yes' ||
        normalized === 'on';
}
