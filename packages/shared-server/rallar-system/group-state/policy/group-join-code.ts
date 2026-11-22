import type { Group } from '@shared/api/group-types.ts';

const RALLAR_GROUP_JOIN_CODE_METADATA_KEY = 'rallarJoinCode';

export function readJoinCode(metadata: Group['metadata']): JoinCodeMetadata | undefined {
    const value = metadata[RALLAR_GROUP_JOIN_CODE_METADATA_KEY];
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        return undefined;
    }
    const candidate = value as Group['metadata'];
    return typeof candidate.version === 'number' &&
            typeof candidate.verifier === 'string' &&
            typeof candidate.expiresAtEpochMs === 'number' &&
            typeof candidate.rotatedAtEpochMs === 'number'
        ? {
            version: candidate.version,
            verifier: candidate.verifier,
            expiresAtEpochMs: candidate.expiresAtEpochMs,
            rotatedAtEpochMs: candidate.rotatedAtEpochMs
        }
        : undefined;
}

interface JoinCodeMetadata {
    readonly version: number;
    readonly verifier: string;
    readonly expiresAtEpochMs: number;
    readonly rotatedAtEpochMs: number;
}

export function mergeJoinCode(metadata: Group['metadata'], joinCode: JoinCodeMetadata): Group['metadata'] {
    return { ...metadata, [RALLAR_GROUP_JOIN_CODE_METADATA_KEY]: { ...joinCode } };
}
