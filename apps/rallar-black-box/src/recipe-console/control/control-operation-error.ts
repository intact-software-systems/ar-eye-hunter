export type ControlOperationErrorKind =
    | 'credential-trust'
    | 'authorization'
    | 'protocol'
    | 'http'
    | 'network'
    | 'aborted'
    | 'unknown';

export type ControlOperationError = Readonly<{
    kind: ControlOperationErrorKind;
    name: string;
    message: string;
    status?: number;
    statusText?: string;
    controlStatus?: number;
    controlStatusText?: string;
    brokerStatus?: number;
    brokerStatusText?: string;
    authorizationRequired?: boolean;
    credentialTrustRequired?: boolean;
    reachable?: boolean;
}>;

export function projectControlOperationError(
    error: unknown
): ControlOperationError {
    const record = error && typeof error === 'object'
        ? error as Record<string, unknown>
        : {};
    const name = error instanceof Error
        ? error.name
        : string(record.name) ?? 'Error';
    const message = error instanceof Error ? error.message : String(error);
    const credentialTrustRequired = boolean(record.credentialTrustRequired);
    const authorizationRequired = boolean(record.authorizationRequired);
    const status = number(record.status);
    const controlStatus = number(record.controlStatus);
    const kind: ControlOperationErrorKind = credentialTrustRequired
        ? 'credential-trust'
        : authorizationRequired
        ? 'authorization'
        : name.includes('Protocol')
        ? 'protocol'
        : status !== undefined || controlStatus !== undefined
        ? 'http'
        : error instanceof TypeError
        ? 'network'
        : name === 'AbortError'
        ? 'aborted'
        : 'unknown';

    return compact({
        kind,
        name,
        message,
        status,
        statusText: string(record.statusText),
        controlStatus,
        controlStatusText: string(record.controlStatusText),
        brokerStatus: number(record.brokerStatus),
        brokerStatusText: string(record.brokerStatusText),
        authorizationRequired,
        credentialTrustRequired,
        reachable: boolean(record.reachable)
    });
}

function compact(
    value: { [Key in keyof ControlOperationError]: ControlOperationError[Key]; }
): ControlOperationError {
    return Object.fromEntries(
        Object.entries(value).filter(([, entry]) => entry !== undefined)
    ) as ControlOperationError;
}

function string(value: unknown): string | undefined {
    return typeof value === 'string' ? value : undefined;
}

function number(value: unknown): number | undefined {
    return typeof value === 'number' ? value : undefined;
}

function boolean(value: unknown): boolean | undefined {
    return typeof value === 'boolean' ? value : undefined;
}
