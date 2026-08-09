import { findUnknownUsages } from './contract-rules.mjs';
import { resolveFunctionNameAtLine } from './function-analysis.mjs';

const displayedFindingCount = 5;
const ruleId = 'boundary.unknown';

export function scanBoundaryUnknownFindings(raw) {
  const usages = findUnknownUsages(raw.split('\n')).map((usage) => ({
    ...usage,
    symbol: resolveFunctionNameAtLine(raw, usage.line),
  }));
  const findings = usages.slice(0, displayedFindingCount).map(toDetailFinding);
  const remainingCountBySymbol = countBySymbol(usages.slice(displayedFindingCount));

  for (const [symbol, count] of remainingCountBySymbol) {
    findings.push({
      affectedCount: count,
      ruleId,
      symbol,
      message:
        `... and ${count} additional unknown occurrence${count === 1 ? '' : 's'} ` +
        'for this owner. Reduce unknown propagation at domain boundaries.',
    });
  }
  return findings;
}

function toDetailFinding(usage) {
  return {
    ruleId,
    symbol: usage.symbol,
    message:
      `Review unknown at line ${usage.line}: ${usage.text} ` +
      'Keep it at an untrusted boundary and normalize it before domain logic.',
  };
}

function countBySymbol(usages) {
  const countByOwner = new Map();
  for (const usage of usages) {
    countByOwner.set(usage.symbol, (countByOwner.get(usage.symbol) ?? 0) + 1);
  }
  return countByOwner;
}
