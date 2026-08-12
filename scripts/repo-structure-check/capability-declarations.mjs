import path from 'node:path';
import { parse } from '@babel/parser';

import { isProductionAuthoredCodePath } from './repository-files.mjs';

export function validateCapabilityDeclarations(input) {
  const authoredFileSet = new Set(input.authoredFiles);
  const issues = [];
  for (const capability of input.capabilities) {
    validateCapabilityControlFlow(issues, capability);
    validateCapabilityPaths(issues, capability, authoredFileSet);
    validateCapabilityCommand(issues, capability, input.packageScripts);
    validateFactContracts(issues, capability, authoredFileSet);
    validateCapabilityComplexity({ issues, input, capability, authoredFileSet });
  }
  validateColdNavigationEvidence(issues, input, authoredFileSet);
  return issues;
}

function validateCapabilityControlFlow(issues, capability) {
  if (
    !Array.isArray(capability.controlFlowFamilies) ||
    capability.controlFlowFamilies.length === 0 ||
    capability.controlFlowFamilies.some(
      (family) => typeof family !== 'string' || family.trim() === '',
    ) ||
    new Set(capability.controlFlowFamilies).size !== capability.controlFlowFamilies.length
  ) {
    issues.push(
      `${capability.owner} controlFlowFamilies must contain unique non-empty family names`,
    );
  }
}

function validateCapabilityPaths(issues, capability, authoredFileSet) {
  if (!hasFileUnder(authoredFileSet, capability.root)) {
    issues.push(`${capability.owner} root ${capability.root} contains no authored code`);
  }
  if (!authoredFileSet.has(capability.entry)) {
    issues.push(`${capability.owner} entry ${capability.entry} does not resolve to authored code`);
  }
  if (!isOwnedEntry(capability)) {
    issues.push(
      `${capability.owner} entry ${capability.entry} must be inside ${capability.root} or its ` +
        'exact thin sibling entry',
    );
  }
  if (!hasFileUnder(authoredFileSet, capability.testRoot)) {
    issues.push(`${capability.owner} test root ${capability.testRoot} contains no authored tests`);
  }
  if (!isRecognizedTestMirror(capability)) {
    issues.push(
      `${capability.owner} test root ${capability.testRoot} must use a recognized mirrored ` +
        `test hierarchy for ${capability.root}`,
    );
  }
  if (![...authoredFileSet].some((file) => isTestModuleUnder(file, capability.testRoot))) {
    issues.push(
      `${capability.owner} test root ${capability.testRoot} contains no authored ` +
        '.test/.spec modules',
    );
  }
}

function validateCapabilityCommand(issues, capability, packageScripts) {
  const commandMatch = /^npm run ([a-z0-9:-]+)$/u.exec(capability.focusedCommand);
  const resolvedCommand = commandMatch && packageScripts[commandMatch[1]];
  const expectedCommand = `vitest run ${capability.testRoot}`;
  if (resolvedCommand !== expectedCommand) {
    issues.push(
      `${capability.owner} focused command ${capability.focusedCommand} must resolve exactly ` +
        `to ${expectedCommand}`,
    );
  }
}

function validateFactContracts(issues, capability, authoredFileSet) {
  for (const factContract of capability.factContracts ?? []) {
    if (!authoredFileSet.has(factContract)) {
      issues.push(
        `${capability.owner} fact contract ${factContract} does not resolve to authored code`,
      );
    }
  }
}

function validateCapabilityComplexity(validation) {
  const { issues, input, capability, authoredFileSet } = validation;
  const productionModuleCount = [...authoredFileSet].filter(
    (file) => isCapabilitySourcePath(capability, file) && isProductionAuthoredCodePath(file),
  ).length;
  const controlFlowFamilyCount = Array.isArray(capability.controlFlowFamilies)
    ? capability.controlFlowFamilies.length
    : 0;
  if (
    (productionModuleCount > 20 || controlFlowFamilyCount >= 3) &&
    capability.navigationMap === null
  ) {
    issues.push(
      `${capability.owner} requires a navigation map (${productionModuleCount} production ` +
        `modules, ${controlFlowFamilyCount} control-flow families)`,
    );
  }
  if (capability.navigationMap !== null) {
    validateNavigationMap({ issues, input, capability, authoredFiles: authoredFileSet });
  }
}

function validateNavigationMap(validation) {
  const { issues, input, capability, authoredFiles } = validation;
  const markdown = input.readFile(capability.navigationMap);
  if (typeof markdown !== 'string') {
    issues.push(`${capability.owner} navigation map ${capability.navigationMap} does not resolve`);
    return;
  }
  const links = [...markdown.matchAll(/\[[^\]]+\]\(([^)]+)\)/gu)];
  let sourceLinkCount = 0;
  let linksToCanonicalEntry = false;
  for (const link of links) {
    const [relativePath, symbol] = link[1].split('#');
    if (
      relativePath === '' ||
      relativePath.startsWith('http:') ||
      relativePath.startsWith('https:')
    ) {
      continue;
    }
    const sourcePath = path.posix.normalize(
      path.posix.join(path.posix.dirname(capability.navigationMap), relativePath),
    );
    if (!isCapabilitySourcePath(capability, sourcePath)) {
      issues.push(
        `${capability.owner} navigation-map path ${sourcePath} is outside its declared owner`,
      );
      continue;
    }
    sourceLinkCount += 1;
    linksToCanonicalEntry ||= sourcePath === capability.entry;
    validateSourceReference({
      issues,
      input,
      authoredFiles,
      sourcePath,
      symbol,
      prefix: `${capability.owner} navigation-map`,
    });
  }
  if (sourceLinkCount === 0) {
    issues.push(
      `${capability.owner} navigation map ${capability.navigationMap} must link to source symbols`,
    );
  }
  if (!linksToCanonicalEntry) {
    issues.push(
      `${capability.owner} navigation map ${capability.navigationMap} must link to canonical ` +
        `entry ${capability.entry}`,
    );
  }
}

function validateColdNavigationEvidence(issues, input, authoredFiles) {
  const evidence = input.coldNavigationEvidence;
  if (evidence === null) {
    return;
  }
  if (!Array.isArray(evidence.probes) || evidence.probes.length === 0) {
    issues.push('cold-navigation evidence must contain at least one path and symbol probe');
    return;
  }
  const capabilitiesByOwner = new Map(
    input.capabilities.map((capability) => [capability.owner, capability]),
  );
  for (const probe of evidence.probes) {
    const capability = capabilitiesByOwner.get(probe.capabilityOwner);
    if (capability === undefined) {
      issues.push(`cold-navigation probe owner ${probe.capabilityOwner} is not declared`);
    } else if (!isCapabilitySourcePath(capability, probe.path)) {
      issues.push(`cold-navigation probe path ${probe.path} is outside ${probe.capabilityOwner}`);
      continue;
    }
    validateSourceReference({
      issues,
      input,
      authoredFiles,
      sourcePath: probe.path,
      symbol: probe.symbol,
      prefix: 'cold-navigation probe',
    });
  }
}

function isCapabilitySourcePath(capability, sourcePath) {
  return sourcePath === capability.entry || sourcePath.startsWith(`${capability.root}/`);
}

function validateSourceReference(reference) {
  if (!reference.authoredFiles.has(reference.sourcePath)) {
    reference.issues.push(
      `${reference.prefix} path ${reference.sourcePath} does not resolve to authored code`,
    );
    return;
  }
  const source = reference.input.readFile(reference.sourcePath);
  if (
    typeof reference.symbol !== 'string' ||
    reference.symbol.trim() === '' ||
    typeof source !== 'string' ||
    !hasNavigableTopLevelSymbol(reference.sourcePath, source, reference.symbol)
  ) {
    const extension = path.posix.extname(reference.sourcePath).toLowerCase();
    if (!supportedSymbolExtensions.has(extension)) {
      reference.issues.push(
        `${reference.prefix} symbol evidence for ${reference.sourcePath} uses unsupported ` +
          `language ${extension || '(none)'}`,
      );
    } else {
      reference.issues.push(
        `${reference.prefix} symbol ${reference.symbol} is not a navigable top-level owner in ` +
          reference.sourcePath,
      );
    }
  }
}

const supportedSymbolExtensions = new Set([
  '.cjs',
  '.cts',
  '.js',
  '.jsx',
  '.mjs',
  '.mts',
  '.py',
  '.sh',
  '.ts',
  '.tsx',
]);

function hasNavigableTopLevelSymbol(file, source, symbol) {
  const extension = path.posix.extname(file).toLowerCase();
  if (extension === '.py') {
    return pythonTopLevelSymbols(source).has(symbol);
  }
  if (extension === '.sh') {
    return shellTopLevelSymbols(source).has(symbol);
  }
  if (!supportedSymbolExtensions.has(extension)) {
    return false;
  }
  try {
    const plugins = file.endsWith('x') ? ['typescript', 'jsx'] : ['typescript'];
    const program = parse(source, { sourceType: 'module', plugins }).program;
    return collectTopLevelJavaScriptNames(program.body).has(symbol);
  } catch {
    return false;
  }
}

function collectTopLevelJavaScriptNames(statements) {
  const names = new Set();
  for (const statement of statements) {
    const node =
      statement.type === 'ExportNamedDeclaration' || statement.type === 'ExportDefaultDeclaration'
        ? statement.declaration
        : statement;
    if (node === null || node === undefined) {
      continue;
    }
    if (
      [
        'ClassDeclaration',
        'FunctionDeclaration',
        'TSInterfaceDeclaration',
        'TSTypeAliasDeclaration',
      ].includes(node.type)
    ) {
      if (node.id?.type === 'Identifier') {
        names.add(node.id.name);
      }
    } else if (node.type === 'VariableDeclaration') {
      for (const declaration of node.declarations) {
        if (declaration.id.type === 'Identifier') {
          names.add(declaration.id.name);
        }
      }
    }
  }
  return names;
}

function pythonTopLevelSymbols(source) {
  const names = new Set();
  for (const line of source.split(/\r?\n/u)) {
    const match = /^(?:(?:async\s+)?def|class)\s+([A-Za-z_]\w*)\b/u.exec(line);
    const assignment = /^([A-Za-z_]\w*)\s*=/u.exec(line);
    if (match !== null || assignment !== null) {
      names.add((match ?? assignment)[1]);
    }
  }
  return names;
}

function shellTopLevelSymbols(source) {
  const names = new Set();
  for (const line of source.split(/\r?\n/u)) {
    const match = /^(?:function\s+)?([A-Za-z_]\w*)\s*\(\)\s*\{/u.exec(line);
    const assignment = /^([A-Za-z_]\w*)=/u.exec(line);
    if (match !== null || assignment !== null) {
      names.add((match ?? assignment)[1]);
    }
  }
  return names;
}

function hasFileUnder(files, root) {
  return [...files].some((file) => file.startsWith(`${root}/`));
}

function isOwnedEntry(capability) {
  if (capability.entry.startsWith(`${capability.root}/`)) {
    return true;
  }
  const entryStem = path.posix.basename(capability.entry, path.posix.extname(capability.entry));
  return (
    path.posix.dirname(capability.entry) === path.posix.dirname(capability.root) &&
    entryStem === path.posix.basename(capability.root)
  );
}

function isRecognizedTestMirror(capability) {
  const [surface, ...ownerParts] = capability.root.split('/');
  if (ownerParts.length === 0) {
    return false;
  }
  const ownerPath = ownerParts.join('/');
  const prefixes = {
    apps: ['packages/tests', 'tests'],
    examples: ['packages/tests/examples', 'tests/examples'],
    packages: ['packages/tests', 'tests'],
    scripts: ['packages/tests/repo', 'tests/repo'],
    tests: ['packages/tests/repo/tests', 'tests/repo/tests'],
  }[surface];
  return prefixes?.some((prefix) => capability.testRoot === `${prefix}/${ownerPath}`) ?? false;
}

function isTestModuleUnder(file, testRoot) {
  return (
    file.startsWith(`${testRoot}/`) && /[.-](?:test|spec)\.[^.]+$/u.test(path.posix.basename(file))
  );
}
