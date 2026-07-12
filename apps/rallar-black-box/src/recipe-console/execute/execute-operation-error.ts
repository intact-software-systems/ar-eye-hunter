export type ExecuteOperationErrorKind =
    | 'credential-trust'
    | 'authorization'
    | 'protocol'
    | 'http'
    | 'network'
    | 'aborted'
    | 'unknown';

export type ExecuteOperationError = Readonly<{
    kind: ExecuteOperationErrorKind;
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

export function projectExecuteOperationError(error: unknown): ExecuteOperationError {
    const record = error && typeof error === 'object'
        ? error as Record<string, unknown>
        : {};
    const name = error instanceof Error ? error.name : string(record.name) ?? 'Error';
    const message = error instanceof Error ? error.message : String(error);
    const credentialTrustRequired = boolean(record.credentialTrustRequired);
    const authorizationRequired = boolean(record.authorizationRequired);
    const status = number(record.status);
    const controlStatus = number(record.controlStatus);
    const kind: ExecuteOperationErrorKind = credentialTrustRequired
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
        reachable: boolean(record.reachable),
    });
}

function compact(
    value: { [Key in keyof ExecuteOperationError]: ExecuteOperationError[Key] },
): ExecuteOperationError {
    return Object.fromEntries(
        Object.entries(value).filter(([, entry]) => entry !== undefined),
    ) as ExecuteOperationError;
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
