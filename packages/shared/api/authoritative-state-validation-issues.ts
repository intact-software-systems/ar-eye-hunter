export interface AuthoritativeStateValidationIssue {
    readonly path: string;
    readonly message: string;
}

type AuthoritativeStateValidationIssueSink = (path: string, message: string) => void;

export class AuthoritativeStateValidation {
    readonly #report: AuthoritativeStateValidationIssueSink;

    constructor(report: AuthoritativeStateValidationIssueSink) {
        this.#report = report;
    }

    issue(path: string, message: string): void {
        this.#report(path, message);
    }

    isRecord(value: unknown): value is Record<string, unknown> {
        return typeof value === 'object' && value !== null && !Array.isArray(value);
    }

    record(value: unknown, path: string): void {
        if (!this.isRecord(value)) {
            this.issue(path, `${path} must be an object`);
        }
    }

    array(value: unknown, path: string): void {
        if (!Array.isArray(value)) {
            this.issue(path, `${path} must be an array`);
        }
    }

    exactKeys(value: object, keys: readonly string[], path: string): void {
        for (const key of keys) {
            if (!Object.hasOwn(value, key)) {
                this.issue(`${path}.${key}`, `${path} is missing ${key}`);
            }
        }
        for (const key of Object.keys(value)) {
            if (!keys.includes(key)) {
                this.issue(`${path}.${key}`, `${path} has unexpected ${key}`);
            }
        }
    }

    string(value: unknown, path: string): void {
        if (typeof value !== 'string' || value.length === 0) {
            this.issue(path, `${path} is invalid`);
        }
    }

    nullableString(value: unknown, path: string): void {
        if (value !== null) {
            this.string(value, path);
        }
    }

    strings(
        value: Readonly<Record<string, unknown>>,
        keys: readonly string[],
        path: string
    ): void {
        for (const key of keys) {
            this.string(value[key], `${path}.${key}`);
        }
    }

    nullableStrings(
        value: Readonly<Record<string, unknown>>,
        keys: readonly string[],
        path: string
    ): void {
        for (const key of keys) {
            this.nullableString(value[key], `${path}.${key}`);
        }
    }

    integer(value: unknown, minimum: number, path: string): void {
        if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < minimum) {
            this.issue(path, `${path} is invalid`);
        }
    }

    nonNegativeIntegers(
        value: Readonly<Record<string, unknown>>,
        keys: readonly string[],
        path: string
    ): void {
        for (const key of keys) {
            this.integer(value[key], 0, `${path}.${key}`);
        }
    }

    positiveIntegers(
        value: Readonly<Record<string, unknown>>,
        keys: readonly string[],
        path: string
    ): void {
        for (const key of keys) {
            this.integer(value[key], 1, `${path}.${key}`);
        }
    }

    nullablePositiveInteger(value: unknown, path: string): void {
        if (value !== null) {
            this.integer(value, 1, path);
        }
    }

    nullablePositiveIntegers(
        value: Readonly<Record<string, unknown>>,
        keys: readonly string[],
        path: string
    ): void {
        for (const key of keys) {
            this.nullablePositiveInteger(value[key], `${path}.${key}`);
        }
    }

    enum(value: unknown, allowed: readonly string[], path: string): void {
        if (typeof value !== 'string' || !allowed.includes(value)) {
            this.issue(path, `${path} is invalid`);
        }
    }

    actor(value: unknown, path: string): void {
        if (!this.isRecord(value)) {
            this.record(value, path);
            return;
        }
        switch (value.kind) {
            case 'principal':
                this.actorFields(value, path, ['kind', 'principalId']);
                return;
            case 'service':
                this.actorFields(value, path, ['kind', 'serviceId']);
                return;
            case 'session':
                this.actorFields(value, path, ['kind', 'sessionId', 'principalId']);
                return;
            default:
                this.issue(`${path}.kind`, `${path}.kind is invalid`);
        }
    }

    audit(value: unknown, path: string): void {
        if (!this.isRecord(value)) {
            this.record(value, path);
            return;
        }
        this.exactKeys(value, ['atEpochMs', 'actor', 'reason', 'traceId', 'requestId'], path);
        this.integer(value.atEpochMs, 0, `${path}.atEpochMs`);
        this.actor(value.actor, `${path}.actor`);
        for (const key of ['reason', 'traceId', 'requestId']) {
            this.nullableString(value[key], `${path}.${key}`);
        }
    }

    nullableAudit(value: unknown, path: string): void {
        if (value !== null) {
            this.audit(value, path);
        }
    }

    audits(
        value: Readonly<Record<string, unknown>>,
        keys: readonly string[],
        path: string
    ): void {
        for (const key of keys) {
            this.audit(value[key], `${path}.${key}`);
        }
    }

    nullableAudits(
        value: Readonly<Record<string, unknown>>,
        keys: readonly string[],
        path: string
    ): void {
        for (const key of keys) {
            this.nullableAudit(value[key], `${path}.${key}`);
        }
    }

    causalRevision(value: unknown, path: string): void {
        if (!this.isRecord(value)) {
            this.record(value, path);
            return;
        }
        this.exactKeys(value, ['groupRevision', 'presenceRevision'], path);
        for (const key of ['groupRevision', 'presenceRevision']) {
            this.integer(value[key], 0, `${path}.${key}`);
        }
    }

    mapPath(source: string, target: string): AuthoritativeStateValidation {
        return new AuthoritativeStateValidation((path, message) => this.issue(path.replace(source, target), message));
    }

    private actorFields(
        value: Readonly<Record<string, unknown>>,
        path: string,
        keys: readonly string[]
    ): void {
        this.exactKeys(value, keys, path);
        for (const key of keys) {
            if (key !== 'kind') {
                this.string(value[key], `${path}.${key}`);
            }
        }
    }
}

export function collectAuthoritativeStateValidationIssues(
    validate: (validation: AuthoritativeStateValidation) => void
): readonly AuthoritativeStateValidationIssue[] {
    const issues: AuthoritativeStateValidationIssue[] = [];
    validate(new AuthoritativeStateValidation((path, message) => issues.push({ path, message })));
    return issues;
}

export const authoritativeStateAssertion = new AuthoritativeStateValidation((_path, message) => {
    throw new TypeError(message);
});
