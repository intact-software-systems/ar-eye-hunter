export type GroupStateSnapshotRepositoryRef = Readonly<{
    applicationId: string;
    workspaceId?: string;
    groupId: string;
}>;

type GroupStateSnapshotRepositoryKey = readonly [
    kind: 'group-state-snapshot',
    applicationId: string,
    workspaceId: readonly [kind: 'absent'] | readonly [kind: 'present', value: string],
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
    const key: GroupStateSnapshotRepositoryKey = [
        'group-state-snapshot',
        ref.applicationId,
        ref.workspaceId === undefined ? ['absent'] : ['present', ref.workspaceId],
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
    return workspaceId[0] === 'present'
        ? { applicationId, workspaceId: workspaceId[1], groupId }
        : { applicationId, groupId };
}

function isGroupStateSnapshotRepositoryKey(
    value: GroupStateSnapshotRepositoryJsonValue
): value is GroupStateSnapshotRepositoryKey {
    if (
        !Array.isArray(value) ||
        value.length !== 4 ||
        value[0] !== 'group-state-snapshot' ||
        typeof value[1] !== 'string' ||
        typeof value[3] !== 'string'
    ) {
        return false;
    }

    const workspaceId = value[2];
    return (
        Array.isArray(workspaceId) &&
        ((workspaceId.length === 1 && workspaceId[0] === 'absent') ||
            (workspaceId.length === 2 &&
                workspaceId[0] === 'present' &&
                typeof workspaceId[1] === 'string'))
    );
}
