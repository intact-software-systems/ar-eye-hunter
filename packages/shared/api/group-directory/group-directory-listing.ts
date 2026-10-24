import type { ApiJsonObject } from '../api-json-value.ts';

export type GroupDirectoryListing = 'listed' | 'unlisted';

export const GROUP_DIRECTORY_LISTING_METADATA_KEY = 'rallarDirectoryListing';

/** Absence is the listed default; a malformed present setting must never publish a room. */
export function toGroupDirectoryListing(metadata: ApiJsonObject): GroupDirectoryListing | null {
    const value = metadata[GROUP_DIRECTORY_LISTING_METADATA_KEY];
    if (value === undefined) {
        return 'listed';
    }
    return value === 'listed' || value === 'unlisted' ? value : null;
}
