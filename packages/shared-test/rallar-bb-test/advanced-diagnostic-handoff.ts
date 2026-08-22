export const ADVANCED_DIAGNOSTIC_HANDOFF_MAX_DIAGNOSTICS = 256;
export const ADVANCED_DIAGNOSTIC_HANDOFF_MAX_CORRELATED_FAILURE_KEYS = 64;
export const ADVANCED_DIAGNOSTIC_HANDOFF_MAX_TEXT_LENGTH = 2_048;

export type AdvancedDiagnosticHandoffSurface =
    | 'auth'
    | 'websocket'
    | 'rtc-diagnostics'
    | 'rooms-clients'
    | 'rallar-server';

export type AdvancedDiagnosticHandoffTarget = Readonly<{
    surface: AdvancedDiagnosticHandoffSurface;
    label: string;
}>;

export type AdvancedDiagnosticHandoffInput = Readonly<{
    failure?: unknown;
    diagnostics?: unknown;
}>;

type DiagnosticHandoffSignals = Readonly<{
    auth: boolean;
    rtc: boolean;
    membership: boolean;
    server: boolean;
}>;

const AUTH_TARGET: AdvancedDiagnosticHandoffTarget = {
    surface: 'auth',
    label: 'Auth'
};
const WEBSOCKET_TARGET: AdvancedDiagnosticHandoffTarget = {
    surface: 'websocket',
    label: 'WebSocket'
};
const RTC_TARGET: AdvancedDiagnosticHandoffTarget = {
    surface: 'rtc-diagnostics',
    label: 'RTC Diagnostics'
};
const MEMBERSHIP_TARGET: AdvancedDiagnosticHandoffTarget = {
    surface: 'rooms-clients',
    label: 'Groups/Clients'
};
const SERVER_TARGET: AdvancedDiagnosticHandoffTarget = {
    surface: 'rallar-server',
    label: 'Rallar Server'
};

const FAILURE_SIGNAL_FIELDS = ['code', 'message'] as const;
const DIAGNOSTIC_SIGNAL_FIELDS = [
    'code',
    'diagnosticTypeId',
    'topic',
    'message',
    'summary',
    'payloadSummary'
] as const;

export function deriveAdvancedDiagnosticHandoffTargets(
    input: unknown
): readonly AdvancedDiagnosticHandoffTarget[] {
    const root = asRecord(input);
    const failure = asRecord(read(root, 'failure'));
    const failureSignals = textSignals(failure, FAILURE_SIGNAL_FIELDS);
    const failureCode = cleanText(read(failure, 'code'))?.trim().toUpperCase();
    const failureKey = cleanIdentity(read(failure, 'key'));
    const correlatedDiagnosticSignals = failureKey
        ? diagnosticSignalsForFailure(read(root, 'diagnostics'), failureKey)
        : [];
    const allSignals = [...failureSignals, ...correlatedDiagnosticSignals];
    const matches: DiagnosticHandoffSignals = {
        auth: allSignals.some(isAuthSignal),
        rtc: failureCode === 'RALLAR_BB_RTC_NO_PEERS' ||
            failureCode === 'RTC_NO_ROUTE' ||
            correlatedDiagnosticSignals.some(isRtcSignal),
        membership: allSignals.some(isMissingMembershipSignal),
        server: failureCode === 'HTTP_SERVICE_UNAVAILABLE' ||
            allSignals.some(isExplicitServerStatusFailure)
    };
    const targets: AdvancedDiagnosticHandoffTarget[] = [];
    if (matches.auth) {
        targets.push(AUTH_TARGET, WEBSOCKET_TARGET);
    }
    if (matches.rtc) {
        targets.push(RTC_TARGET);
    }
    if (matches.membership) {
        targets.push(MEMBERSHIP_TARGET);
    }
    if (matches.server) {
        targets.push(SERVER_TARGET);
    }
    return targets;
}

function diagnosticSignalsForFailure(value: unknown, failureKey: string): readonly string[] {
    if (!Array.isArray(value)) {
        return [];
    }
    const signals: string[] = [];
    const limit = Math.min(value.length, ADVANCED_DIAGNOSTIC_HANDOFF_MAX_DIAGNOSTICS);
    for (let index = 0; index < limit; index += 1) {
        const diagnostic = asRecord(readIndex(value, index));
        if (!hasCorrelatedFailureKey(read(diagnostic, 'correlatedFailureKeys'), failureKey)) {
            continue;
        }
        signals.push(...textSignals(diagnostic, DIAGNOSTIC_SIGNAL_FIELDS));
    }
    return signals;
}

function hasCorrelatedFailureKey(value: unknown, failureKey: string): boolean {
    if (!Array.isArray(value)) {
        return false;
    }
    const limit = Math.min(
        value.length,
        ADVANCED_DIAGNOSTIC_HANDOFF_MAX_CORRELATED_FAILURE_KEYS
    );
    for (let index = 0; index < limit; index += 1) {
        if (cleanIdentity(readIndex(value, index)) === failureKey) {
            return true;
        }
    }
    return false;
}

function textSignals(
    record: Readonly<Record<string, unknown>>,
    fields: readonly string[]
): readonly string[] {
    const signals: string[] = [];
    for (const field of fields) {
        const text = cleanText(read(record, field));
        if (text) {
            signals.push(text.toLowerCase());
        }
    }
    return signals;
}

function isAuthSignal(signal: string): boolean {
    return boundedPatternTest(signal, /(?:^|[^a-z0-9])bad[_ -]?auth(?:$|[^a-z0-9])/) ||
        boundedPatternTest(signal, /(?:^|[^a-z0-9])ticket(?:$|[^a-z0-9])/) ||
        boundedPatternTest(signal, /(?:^|[^a-z0-9])unauthorized(?:$|[^a-z0-9])/) ||
        boundedPatternTest(signal, /(?:^|[^a-z0-9])forbidden(?:$|[^a-z0-9])/);
}

function isRtcSignal(signal: string): boolean {
    return boundedPatternTest(signal, /(?:^|[^a-z0-9])no[_ -]?peers?(?:$|[^a-z0-9])/) ||
        boundedPatternTest(signal, /(?:^|[^a-z0-9])no[_ -]?route(?:$|[^a-z0-9])/);
}

function isMissingMembershipSignal(signal: string): boolean {
    return boundedPatternTest(
        signal,
        /(?:^|[^a-z0-9])(?:missing|no)[_ -]+(?:group|member)(?:$|[^a-z0-9])/
    ) || boundedPatternTest(
        signal,
        /(?:^|[^a-z0-9])(?:group|member)[_ -]+(?:(?:is|was)[_ -]+)?(?:missing|not[_ -]+found)(?:$|[^a-z0-9])/
    );
}

function isExplicitServerStatusFailure(signal: string): boolean {
    return boundedPatternTest(
        signal,
        /(?:^|[^a-z0-9])http[_ -]+service[_ -]+unavailable(?:$|[^a-z0-9])/
    ) || boundedPatternTest(
        signal,
        /(?:^|[^a-z0-9])http[_ -]+status[_ -]+(?:5[0-9]{2}|failed|failure|error)(?:$|[^a-z0-9])/
    ) || boundedPatternTest(
        signal,
        /(?:^|[^a-z0-9])(?:rallar[_ -]+)?server[_ -]+status[_ -]+(?:5[0-9]{2}|failed|failure|error)(?:$|[^a-z0-9])/
    );
}

function boundedPatternTest(value: string, pattern: RegExp): boolean {
    return pattern.test(value.slice(0, ADVANCED_DIAGNOSTIC_HANDOFF_MAX_TEXT_LENGTH));
}

function cleanText(value: unknown): string | undefined {
    if (typeof value !== 'string') {
        return undefined;
    }
    const bounded = value.slice(0, ADVANCED_DIAGNOSTIC_HANDOFF_MAX_TEXT_LENGTH);
    return bounded.trim().length > 0 ? bounded : undefined;
}

function cleanIdentity(value: unknown): string | undefined {
    if (typeof value !== 'string' || value.length > ADVANCED_DIAGNOSTIC_HANDOFF_MAX_TEXT_LENGTH) {
        return undefined;
    }
    const clean = value.trim();
    return clean.length > 0 ? clean : undefined;
}

function asRecord(value: unknown): Readonly<Record<string, unknown>> {
    return typeof value === 'object' && value !== null
        ? value as Readonly<Record<string, unknown>>
        : {};
}

function read(record: Readonly<Record<string, unknown>>, key: string): unknown {
    try {
        return record[key];
    }
    catch {
        return undefined;
    }
}

function readIndex(values: readonly unknown[], index: number): unknown {
    try {
        return values[index];
    }
    catch {
        return undefined;
    }
}
