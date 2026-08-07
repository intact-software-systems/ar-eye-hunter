import {
  isRuntimeStatePrefixPageRepositoryLike,
  type RuntimeStateEntry,
  type RuntimeStateRepositoryLike,
} from '../../../runtime-state/RuntimeStateRepository.ts';

// Operators must migrate plaintext-key auth rows before this removal boundary.
// Delete the compatibility readers after the deadline; do not extend them silently.
export const AUTH_LEGACY_PLAINTEXT_COMPATIBILITY_DEADLINE_EPOCH_MS = Date.parse(
  '2026-12-31T00:00:00.000Z',
);
export const AUTH_LEGACY_PLAINTEXT_SCAN_LIMIT = 128;

export function isLegacyPlaintextCompatibilityActive(): boolean {
  return Date.now() < AUTH_LEGACY_PLAINTEXT_COMPATIBILITY_DEADLINE_EPOCH_MS;
}

export async function readBoundedLegacyAuthPage(
  repository: RuntimeStateRepositoryLike,
  namespace: string,
  keyPrefix: string,
): Promise<readonly RuntimeStateEntry[]> {
  if (!isLegacyPlaintextCompatibilityActive()) return [];
  if (!isRuntimeStatePrefixPageRepositoryLike(repository)) {
    throw new TypeError('Legacy plaintext auth compatibility requires bounded pagination');
  }
  const entries = await repository.findEntriesByPrefixPage(namespace, keyPrefix, {
    limit: AUTH_LEGACY_PLAINTEXT_SCAN_LIMIT + 1,
  });
  if (entries.length > AUTH_LEGACY_PLAINTEXT_SCAN_LIMIT) {
    throw new RangeError('Legacy plaintext auth compatibility scan limit exceeded');
  }
  return entries;
}
