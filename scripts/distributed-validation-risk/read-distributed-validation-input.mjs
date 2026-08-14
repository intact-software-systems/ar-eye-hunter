import { readChangedPathsBetweenRevisions } from '../repository-changes/read-git-changes.mjs';

export function readChangedPathRecords(repoRoot, base, head) {
  return {
    records: readChangedPathsBetweenRevisions(repoRoot, base, head).map((change) => ({
      status: change.status,
      paths: [change.oldPath, change.path].filter(Boolean),
    })),
    issues: [],
  };
}
