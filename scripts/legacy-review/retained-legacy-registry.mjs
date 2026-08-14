const requiredFields = new Map([
  ['Path', 'path'],
  ['Symbol', 'symbol'],
  ['Purpose', 'purpose'],
  ['Canonical owner', 'canonicalOwner'],
  ['Consumer dependency', 'consumerDependency'],
  ['Why removal is unsafe', 'unsafeRemovalReason'],
  ['Minimization', 'minimization'],
  ['Compatibility tests', 'compatibilityTests'],
  ['Named owner', 'owner'],
  ['Review or removal condition', 'reviewCondition'],
]);

const forbiddenMetadataPattern =
  /(?:approval date|reviewer|pull request|\bpr\b|commit|sha|plan|candidate id|review id)/iu;

export function readRetainedLegacyRegistry(source) {
  const entries = [];
  const issues = [];
  const identities = new Set();

  for (const section of readEntrySections(withoutFencedExamples(source))) {
    const entry = readEntry(section, issues);
    if (!entry) {
      continue;
    }

    const identity = `${entry.path}#${entry.symbol}`;
    if (section.heading !== identity) {
      issues.push(`retained legacy registry heading must be ${identity}`);
    }
    if (identities.has(identity)) {
      issues.push(`retained legacy registry duplicates ${identity}`);
      continue;
    }

    identities.add(identity);
    entries.push(entry);
  }

  return { entries, issues };
}

function withoutFencedExamples(source) {
  return source.replace(/```[\s\S]*?```/gu, '');
}

function readEntrySections(source) {
  const lines = source.split(/\r?\n/u);
  const sections = [];
  let inRegistry = false;
  let current;

  for (const line of lines) {
    if (/^##\s+Retained exceptions\s*$/iu.test(line)) {
      inRegistry = true;
      current = undefined;
      continue;
    }
    if (/^##\s+/u.test(line)) {
      inRegistry = false;
      current = undefined;
      continue;
    }
    if (!inRegistry) {
      continue;
    }

    const heading = line.match(/^###\s+(.+?)\s*$/u)?.[1];
    if (heading) {
      current = { heading, lines: [] };
      sections.push(current);
      continue;
    }
    current?.lines.push(line);
  }

  return sections;
}

function readEntry(section, issues) {
  const values = new Map();
  for (const line of section.lines) {
    const field = line.match(/^-\s+([^:]+):\s*(.*?)\s*$/u);
    if (!field) {
      continue;
    }

    const [, label, value] = field;
    if (forbiddenMetadataPattern.test(label)) {
      issues.push(`retained legacy registry contains PR or commit tracking: ${section.heading}`);
      continue;
    }
    if (requiredFields.has(label)) {
      values.set(label, value);
    }
  }

  for (const label of requiredFields.keys()) {
    if (!values.get(label)) {
      issues.push(`retained legacy registry entry is missing ${label}: ${section.heading}`);
    }
  }
  if ([...requiredFields.keys()].some((label) => !values.get(label))) {
    return undefined;
  }

  return Object.fromEntries(
    [...requiredFields].map(([label, property]) => [property, values.get(label)]),
  );
}
