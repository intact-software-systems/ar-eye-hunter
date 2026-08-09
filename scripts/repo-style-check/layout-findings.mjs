import path from 'node:path';

export function toFinding(file, ruleId, message) {
  return toSymbolLayoutFinding({ file, ruleId, message, symbol: path.basename(file) });
}

function toSymbolLayoutFinding(input) {
  return { ...input, affectedCount: 1, kind: 'warn' };
}

export function compareFindings(left, right) {
  return (
    compareCodeUnits(left.file, right.file) ||
    compareCodeUnits(left.ruleId, right.ruleId) ||
    compareCodeUnits(left.message, right.message)
  );
}

export const compareCodeUnits = (left, right) => (left === right ? 0 : left < right ? -1 : 1);
