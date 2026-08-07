export type ClientStateSnapshotRepositoryRef = Readonly<{
  applicationId: string;
  workspaceId?: string;
  principalId: string;
}>;

type ClientStateSnapshotRepositoryKey = readonly [
  kind: 'client-state-snapshot',
  applicationId: string,
  workspaceId: readonly [kind: 'absent'] | readonly [kind: 'present', value: string],
  principalId: string,
];

type ClientStateSnapshotRepositoryJsonValue =
  | null
  | boolean
  | number
  | string
  | readonly ClientStateSnapshotRepositoryJsonValue[]
  | { readonly [key: string]: ClientStateSnapshotRepositoryJsonValue };

export function toClientStateSnapshotRepositoryKey(ref: ClientStateSnapshotRepositoryRef): string {
  const key: ClientStateSnapshotRepositoryKey = [
    'client-state-snapshot',
    ref.applicationId,
    ref.workspaceId === undefined ? ['absent'] : ['present', ref.workspaceId],
    ref.principalId,
  ];
  return JSON.stringify(key);
}

export function fromClientStateSnapshotRepositoryKey(
  key: string,
): ClientStateSnapshotRepositoryRef {
  const parsed = JSON.parse(key) as ClientStateSnapshotRepositoryJsonValue;
  if (!isClientStateSnapshotRepositoryKey(parsed)) {
    throw new Error('Invalid client state snapshot repository key');
  }

  const [, applicationId, workspaceId, principalId] = parsed;
  return workspaceId[0] === 'present'
    ? { applicationId, workspaceId: workspaceId[1], principalId }
    : { applicationId, principalId };
}

function isClientStateSnapshotRepositoryKey(
  value: ClientStateSnapshotRepositoryJsonValue,
): value is ClientStateSnapshotRepositoryKey {
  if (
    !Array.isArray(value) ||
    value.length !== 4 ||
    value[0] !== 'client-state-snapshot' ||
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
