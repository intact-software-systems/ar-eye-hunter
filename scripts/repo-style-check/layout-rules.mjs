import path from 'node:path';

import { parse } from '@babel/parser';

const typeScriptSuffixPattern = /(?:\.d)?\.(?:ts|tsx|mts|cts)$/u;
const kebabCasePattern = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u;
const genericFileStems = new Set([
  'utils',
  'types',
  'helpers',
  'contracts',
  'runtime',
  'middleware',
]);
const conventionalToolFileNames = new Set(['prisma.config.ts', 'vite.config.ts']);
const ignoredLeadingFeatureTokens = new Set([
  'app',
  'api',
  'browser',
  'cached',
  'compute',
  'create',
  'default',
  'rallar',
  'read',
  'register',
  'server',
  'shared',
  'to',
  'use',
  'v1',
  'v2',
  'validate',
  'write',
]);
const approvedModCompatibilityBoundaries = new Set([
  'packages/relic-hunters/mod.ts',
  'packages/shared-graph/mod.ts',
  'packages/shared-server/game/mod.ts',
  'packages/shared-server/mod.ts',
  'packages/shared-server/rallar-ai/mod.ts',
  'packages/shared-test/rallar-bb-test/mod.ts',
  'packages/shared-web/game/mod.ts',
  'packages/shared-web/mod.ts',
  'packages/shared/crdt/mod.ts',
  'packages/shared/mod.ts',
  'packages/shared/rallar-ai/mod.ts',
  'packages/shared/rallar-game/mod.ts',
  'packages/shared/rallar-match/mod.ts',
  'packages/shared/rallar-motion/mod.ts',
]);

export const layoutLimits = Object.freeze({
  directTypeScriptFileCount: 20,
  featurePrefixFileCount: 4,
  displayedFileSampleCount: 5,
});

export const layoutRuleIds = Object.freeze({
  directoryDensity: 'layout.directory-density',
  featurePrefixCluster: 'layout.feature-prefix-cluster',
  filenameStyle: 'layout.filename-style',
  genericFilename: 'layout.generic-filename',
  genericRouteInit: 'layout.generic-route-init',
  unapprovedMod: 'layout.unapproved-mod',
  primaryExportName: 'layout.primary-export-name',
  browserRoomBoundary: 'layout.browser-room-boundary',
  serverGroupStateVocabulary: 'layout.server-group-state-vocabulary',
});

export function isLayoutTypeScriptFile(file) {
  return typeScriptSuffixPattern.test(file);
}

export function toKebabCase(value) {
  return value
    .replace(/([A-Z]+)([A-Z][a-z])/gu, '$1-$2')
    .replace(/([a-z0-9])([A-Z])/gu, '$1-$2')
    .replace(/[_\s]+/gu, '-')
    .replace(/-+/gu, '-')
    .replace(/^-|-$/gu, '')
    .toLowerCase();
}

export function scanRepositoryLayout(input) {
  const sources = input.sources
    .filter((source) => isLayoutTypeScriptFile(source.file))
    .map((source) => ({ ...source, file: path.resolve(source.file) }));
  const findings = [];

  scanDirectories(sources, findings);
  scanRouteRegistrations(sources, findings);
  scanModBoundaries(input.repoRoot, sources, findings);

  findings.sort(compareFindings);

  const counts = Object.fromEntries(Object.values(layoutRuleIds).map((ruleId) => [ruleId, 0]));
  for (const finding of findings) {
    counts[finding.ruleId] += finding.affectedCount;
  }

  return { findings, counts };
}

function scanDirectories(sources, findings) {
  const sourcesByDirectory = groupBy(sources, (source) => path.dirname(source.file));

  for (const directory of [...sourcesByDirectory.keys()].sort()) {
    const directSources = sourcesByDirectory
      .get(directory)
      .toSorted((left, right) => path.basename(left.file).localeCompare(path.basename(right.file)));

    scanDirectoryDensity(directory, directSources, findings);
    scanFilenameStyle(directory, directSources, findings);
    scanGenericFilenames(directory, directSources, findings);
  }
}

function scanDirectoryDensity(directory, directSources, findings) {
  if (directSources.length <= layoutLimits.directTypeScriptFileCount) {
    return;
  }

  findings.push(
    finding({
      file: directory,
      ruleId: layoutRuleIds.directoryDensity,
      affectedCount: 1,
      message:
        `Review feature ownership: this directory has ${directSources.length} ` +
        'direct production TypeScript files ' +
        `(review threshold > ${layoutLimits.directTypeScriptFileCount}). This is ` +
        'not an instruction to create folders or pass-through modules mechanically.',
    }),
  );

  const directoryTokens = new Set(toKebabCase(path.basename(directory)).split('-'));
  const filesByPrefix = groupBy(
    directSources.filter((source) => getFeaturePrefix(source.file, directoryTokens) !== undefined),
    (source) => getFeaturePrefix(source.file, directoryTokens),
  );

  for (const prefix of [...filesByPrefix.keys()].sort()) {
    const fileNames = filesByPrefix
      .get(prefix)
      .map((source) => path.basename(source.file))
      .sort();
    if (fileNames.length < layoutLimits.featurePrefixFileCount) {
      continue;
    }

    findings.push(
      finding({
        file: directory,
        ruleId: layoutRuleIds.featurePrefixCluster,
        affectedCount: 1,
        message:
          `Review feature ownership: prefix '${prefix}' appears in ` +
          `${fileNames.length} direct files. Samples: ${sampleFileNames(fileNames)}. ` +
          'This is not an instruction to create folders or ' +
          'pass-through modules mechanically.',
      }),
    );
  }
}

function scanFilenameStyle(directory, directSources, findings) {
  const nonKebabFileNames = directSources
    .map((source) => path.basename(source.file))
    .filter((fileName) => !conventionalToolFileNames.has(fileName))
    .filter((fileName) => !kebabCasePattern.test(toTypeScriptStem(fileName)));

  if (nonKebabFileNames.length === 0) {
    return;
  }

  findings.push(
    finding({
      file: directory,
      ruleId: layoutRuleIds.filenameStyle,
      affectedCount: nonKebabFileNames.length,
      message:
        `${nonKebabFileNames.length} TypeScript filenames are not kebab-case. ` +
        `Samples: ${sampleFileNames(nonKebabFileNames)}.`,
    }),
  );
}

function scanGenericFilenames(directory, directSources, findings) {
  const genericFileNames = directSources
    .map((source) => path.basename(source.file))
    .filter((fileName) => genericFileStems.has(toTypeScriptStem(fileName)));

  if (genericFileNames.length === 0) {
    return;
  }

  findings.push(
    finding({
      file: directory,
      ruleId: layoutRuleIds.genericFilename,
      affectedCount: genericFileNames.length,
      message:
        `${genericFileNames.length} generic filenames need an owning feature noun and role. ` +
        `Samples: ${sampleFileNames(genericFileNames)}.`,
    }),
  );
}

function scanRouteRegistrations(sources, findings) {
  for (const source of sources) {
    const stem = toTypeScriptStem(path.basename(source.file));
    if (!stem.endsWith('-route') && !stem.endsWith('-routes')) {
      continue;
    }
    if (!hasExportedInitFunction(source)) {
      continue;
    }

    findings.push(
      finding({
        file: source.file,
        ruleId: layoutRuleIds.genericRouteInit,
        affectedCount: 1,
        message: 'Exported route registration function init needs a descriptive feature name.',
      }),
    );
  }
}

function scanModBoundaries(repoRoot, sources, findings) {
  for (const source of sources) {
    if (path.basename(source.file) !== 'mod.ts') {
      continue;
    }

    const relativeFile = path.relative(repoRoot, source.file).split(path.sep).join('/');
    if (approvedModCompatibilityBoundaries.has(relativeFile)) {
      continue;
    }

    findings.push(
      finding({
        file: source.file,
        ruleId: layoutRuleIds.unapprovedMod,
        affectedCount: 1,
        message: 'mod.ts is not an approved package compatibility boundary.',
      }),
    );
  }
}

function getFeaturePrefix(file, directoryTokens) {
  const tokens = toKebabCase(toTypeScriptStem(path.basename(file))).split('-');
  while (ignoredLeadingFeatureTokens.has(tokens[0])) {
    tokens.shift();
  }

  const prefix = tokens[0];
  return prefix === undefined || directoryTokens.has(prefix) ? undefined : prefix;
}

function hasExportedInitFunction(source) {
  const plugins = ['typescript'];
  if (source.file.endsWith('.tsx')) {
    plugins.push('jsx');
  }

  const program = parse(source.raw, {
    sourceFilename: source.file,
    sourceType: 'module',
    plugins,
  }).program;

  return program.body.some((statement) => {
    if (statement.type !== 'ExportNamedDeclaration' || statement.declaration === null) {
      return false;
    }
    if (statement.declaration.type === 'FunctionDeclaration') {
      return statement.declaration.id?.name === 'init';
    }
    if (statement.declaration.type !== 'VariableDeclaration') {
      return false;
    }

    return statement.declaration.declarations.some(
      (declaration) =>
        declaration.id.type === 'Identifier' &&
        declaration.id.name === 'init' &&
        declaration.init !== null &&
        (declaration.init.type === 'ArrowFunctionExpression' ||
          declaration.init.type === 'FunctionExpression'),
    );
  });
}

function toTypeScriptStem(fileName) {
  return fileName.replace(typeScriptSuffixPattern, '');
}

function sampleFileNames(fileNames) {
  return [...fileNames].sort().slice(0, layoutLimits.displayedFileSampleCount).join(', ');
}

function groupBy(values, toKey) {
  const valuesByKey = new Map();
  for (const value of values) {
    const key = toKey(value);
    const groupedValues = valuesByKey.get(key) ?? [];
    groupedValues.push(value);
    valuesByKey.set(key, groupedValues);
  }
  return valuesByKey;
}

function finding(input) {
  return { ...input, kind: 'warn' };
}

function compareFindings(left, right) {
  return (
    compareCodeUnits(left.file, right.file) ||
    compareCodeUnits(left.ruleId, right.ruleId) ||
    compareCodeUnits(left.message, right.message)
  );
}

function compareCodeUnits(left, right) {
  if (left === right) {
    return 0;
  }

  return left < right ? -1 : 1;
}
