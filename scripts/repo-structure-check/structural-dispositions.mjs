import path from 'node:path';

const dispositions = new Set(['keep', 'split', 'move', 'consolidate']);

export function validateStructuralDispositions(facts, declaredDispositions) {
  const validTargets = new Set(
    declaredDispositions
      .filter(
        (disposition) =>
          dispositions.has(disposition.disposition) &&
          typeof disposition.rationale === 'string' &&
          disposition.rationale.trim() !== '',
      )
      .map((disposition) => disposition.target),
  );
  return facts
    .map(toDispositionTarget)
    .filter((target) => !validTargets.has(target))
    .sort(compareCodeUnits)
    .map(
      (target) =>
        `${target} requires an explicit keep/split/move/consolidate disposition; ` +
        'automation does not choose one',
    );
}

export function collectSemanticDepthFacts(input) {
  const factsByTarget = new Map();
  for (const capability of input.capabilities) {
    for (const file of input.authoredFiles) {
      if (!file.startsWith(`${capability.root}/`)) {
        continue;
      }
      const relativeDirectory = path.posix.dirname(file.slice(capability.root.length + 1));
      if (relativeDirectory === '.') {
        continue;
      }
      const magnitude = relativeDirectory.split('/').length;
      if (magnitude < 2) {
        continue;
      }
      const target = `${capability.root}/${relativeDirectory}`;
      factsByTarget.set(target, {
        ruleId: 'structure.semantic-depth',
        target,
        magnitude,
      });
    }
  }
  return [...factsByTarget.values()].sort((left, right) =>
    compareCodeUnits(left.target, right.target),
  );
}

function toDispositionTarget(fact) {
  const identity = fact.identity === undefined ? '' : `:${fact.identity}`;
  return `${fact.target} [${fact.ruleId}${identity}]`;
}

const compareCodeUnits = (left, right) => Buffer.compare(Buffer.from(left), Buffer.from(right));
