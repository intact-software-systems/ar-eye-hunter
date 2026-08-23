export type ClientStateSnapshotRepositoryRef = Readonly<{
    applicationId: string;
    workspaceId: string;
    principalId: string;
}>;

type ClientStateSnapshotRepositoryKey = readonly [
    kind: 'client-state-snapshot',
    applicationId: string,
    workspaceId: string,
    principalId: string
];

type ClientStateSnapshotRepositoryJsonValue =
    | null
    | boolean
    | number
    | string
    | readonly ClientStateSnapshotRepositoryJsonValue[]
    | { readonly [key: string]: ClientStateSnapshotRepositoryJsonValue; };

export function toClientStateSnapshotRepositoryKey(ref: ClientStateSnapshotRepositoryRef): string {
    if (![ref.applicationId, ref.workspaceId, ref.principalId].every(isNonEmptyString)) {
        throw new TypeError('Client state snapshot repository identity is invalid');
    }
    const key: ClientStateSnapshotRepositoryKey = [
        'client-state-snapshot',
        ref.applicationId,
        ref.workspaceId,
        ref.principalId
    ];
    return JSON.stringify(key);
}

export function fromClientStateSnapshotRepositoryKey(
    key: string
): ClientStateSnapshotRepositoryRef {
    const parsed = JSON.parse(key) as ClientStateSnapshotRepositoryJsonValue;
    if (!isClientStateSnapshotRepositoryKey(parsed)) {
        throw new Error('Invalid client state snapshot repository key');
    }

    const [, applicationId, workspaceId, principalId] = parsed;
    return { applicationId, workspaceId, principalId };
}

function isClientStateSnapshotRepositoryKey(
    value: ClientStateSnapshotRepositoryJsonValue
): value is ClientStateSnapshotRepositoryKey {
    if (
        !Array.isArray(value) ||
        value.length !== 4 ||
        value[0] !== 'client-state-snapshot' ||
        !isNonEmptyString(value[1]) ||
        !isNonEmptyString(value[2]) ||
        !isNonEmptyString(value[3])
    ) {
        return false;
    }

    return true;
}

function isNonEmptyString(value: ClientStateSnapshotRepositoryJsonValue): value is string {
    return typeof value === 'string' && value.length > 0;
}
