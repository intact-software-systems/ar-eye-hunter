import path from 'node:path';

const dispositions = new Set(['keep', 'split', 'move', 'consolidate']);

export function validateStructuralDispositions(input) {
  const issues = [];
  const currentFacts = new Map(input.facts.map((fact) => [factIdentity(fact), fact]));
  const satisfiedFacts = new Set();
  for (const disposition of input.declaredDispositions) {
    if (disposition.kind !== 'current-fact') {
      continue;
    }
    const label = toDispositionTarget(disposition);
    if (disposition.affectedCodeDigest !== input.affectedCodeDigest) {
      issues.push(`${label} disposition has stale affected-code digest`);
      continue;
    }
    const identity = factIdentity(disposition);
    if (!currentFacts.has(identity)) {
      issues.push(`${label} disposition does not match a current structural fact`);
      continue;
    }
    if (!isHumanDisposition(disposition)) {
      issues.push(`${label} disposition must contain a judgment and rationale`);
      continue;
    }
    satisfiedFacts.add(identity);
  }
  issues.push(
    ...input.facts
      .filter((fact) => !satisfiedFacts.has(factIdentity(fact)))
      .map(toDispositionTarget)
      .sort(compareCodeUnits)
      .map(
        (target) =>
          `${target} requires an explicit keep/split/move/consolidate disposition; ` +
          'automation does not choose one',
      ),
  );
  return issues;
}

export function collectSemanticDepthFacts(input) {
  const factsByTarget = new Map();
  for (const capability of input.capabilities) {
    if (capability.kind === 'guidance') {
      continue;
    }
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
  const identity = fact.identity == null ? '' : `:${fact.identity}`;
  return `${fact.target} [${fact.ruleId}${identity}]`;
}

function factIdentity(fact) {
  return JSON.stringify({
    ruleId: fact.ruleId,
    target: fact.target,
    identity: fact.identity ?? null,
    magnitude: fact.magnitude,
  });
}

function isHumanDisposition(disposition) {
  return (
    dispositions.has(disposition.disposition) &&
    typeof disposition.rationale === 'string' &&
    disposition.rationale.trim() !== ''
  );
}

const compareCodeUnits = (left, right) => Buffer.compare(Buffer.from(left), Buffer.from(right));
