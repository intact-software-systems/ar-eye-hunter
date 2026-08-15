const directDispositions = new Set(['removed', 'resolved', 'minimized-boundary']);

export function validateRetainedLegacy({ items, registryEntries }) {
  const issues = [];
  const registryIdentities = new Set(
    registryEntries.map((entry) => `${entry.path}#${entry.symbol}`),
  );
  const reviewedIdentities = new Set();

  for (const item of items) {
    const identity = `${item?.path ?? ''}#${item?.symbol ?? ''}`;
    if (!item?.path || !item?.symbol) {
      issues.push('production legacy disposition requires a path and symbol');
      continue;
    }
    if (reviewedIdentities.has(identity)) {
      issues.push(`production legacy review duplicates ${identity}`);
      continue;
    }
    reviewedIdentities.add(identity);

    if (directDispositions.has(item.disposition)) {
      continue;
    }
    if (item.disposition === 'retained') {
      if (!registryIdentities.has(identity)) {
        issues.push(`retained production legacy requires a registry entry: ${identity}`);
      }
      continue;
    }
    issues.push(`production legacy disposition is invalid: ${identity}`);
  }

  return issues;
}
