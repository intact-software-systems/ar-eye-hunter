export type GroupStateSnapshotRepositoryRef = Readonly<{
    applicationId: string;
    workspaceId: string;
    groupId: string;
}>;

type GroupStateSnapshotRepositoryKey = readonly [
    kind: 'group-state-snapshot',
    applicationId: string,
    workspaceId: string,
    groupId: string
];

type GroupStateSnapshotRepositoryJsonValue =
    | null
    | boolean
    | number
    | string
    | readonly GroupStateSnapshotRepositoryJsonValue[]
    | { readonly [key: string]: GroupStateSnapshotRepositoryJsonValue; };

export function toGroupStateSnapshotRepositoryKey(ref: GroupStateSnapshotRepositoryRef): string {
    if (![ref.applicationId, ref.workspaceId, ref.groupId].every(isNonEmptyString)) {
        throw new TypeError('Group state snapshot repository identity is invalid');
    }
    const key: GroupStateSnapshotRepositoryKey = [
        'group-state-snapshot',
        ref.applicationId,
        ref.workspaceId,
        ref.groupId
    ];
    return JSON.stringify(key);
}

export function fromGroupStateSnapshotRepositoryKey(key: string): GroupStateSnapshotRepositoryRef {
    const parsed = JSON.parse(key) as GroupStateSnapshotRepositoryJsonValue;
    if (!isGroupStateSnapshotRepositoryKey(parsed)) {
        throw new Error('Invalid group state snapshot repository key');
    }

    const [, applicationId, workspaceId, groupId] = parsed;
    return { applicationId, workspaceId, groupId };
}

function isGroupStateSnapshotRepositoryKey(
    value: GroupStateSnapshotRepositoryJsonValue
): value is GroupStateSnapshotRepositoryKey {
    if (
        !Array.isArray(value) ||
        value.length !== 4 ||
        value[0] !== 'group-state-snapshot' ||
        !isNonEmptyString(value[1]) ||
        !isNonEmptyString(value[2]) ||
        !isNonEmptyString(value[3])
    ) {
        return false;
    }

    return true;
}

function isNonEmptyString(value: GroupStateSnapshotRepositoryJsonValue): value is string {
    return typeof value === 'string' && value.length > 0;
}
