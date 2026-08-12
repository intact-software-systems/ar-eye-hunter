import path from 'node:path';
import { parse } from '@babel/parser';

import { isProductionAuthoredCodePath } from './repository-files.mjs';
import { isPlannedCapability } from '../plan-adaptation/adaptive-plan-record.mjs';

export function validateCapabilityDeclarations(input) {
  const authoredFileSet = new Set(input.authoredFiles);
  const repositoryFileSet = new Set(input.repositoryFiles ?? input.authoredFiles);
  const issues = [];
  for (const capability of input.capabilities) {
    if (isPlannedCapability(capability)) {
      continue;
    }
    if (capability.kind === 'guidance') {
      validateGuidanceCapability({ issues, capability, repositoryFileSet, input });
    } else {
      validateCapabilityControlFlow(issues, capability);
      validateCapabilityPaths(issues, capability, authoredFileSet);
      validateCapabilityCommand(issues, capability, input.packageScripts);
      validateFactContracts(issues, capability, authoredFileSet);
      validateCapabilityComplexity({ issues, input, capability, authoredFileSet });
    }
  }
  validateColdNavigationEvidence({ issues, input, authoredFileSet, repositoryFileSet });
  return issues;
}

function validateGuidanceCapability(validation) {
  const { issues, capability, repositoryFileSet, input } = validation;
  if (!hasFileUnder(repositoryFileSet, capability.skillRoot)) {
    issues.push(
      `${capability.owner} skill root ${capability.skillRoot} contains no repository files`,
    );
  }
  if (!repositoryFileSet.has(capability.skillEntry)) {
    issues.push(`${capability.owner} skill entry ${capability.skillEntry} does not resolve`);
  }
  if (capability.skillEntry !== `${capability.skillRoot}/SKILL.md`) {
    issues.push(`${capability.owner} skill entry must be SKILL.md inside ${capability.skillRoot}`);
  }
  if (!hasFileUnder(repositoryFileSet, capability.contractTestRoot)) {
    issues.push(
      `${capability.owner} contract test root ${capability.contractTestRoot} contains no tests`,
    );
  } else if (
    ![...repositoryFileSet].some((file) => isTestModuleUnder(file, capability.contractTestRoot))
  ) {
    issues.push(
      `${capability.owner} contract test root ${capability.contractTestRoot} contains no ` +
        '.test/.spec modules',
    );
  }
  if (!isRecognizedGuidanceTestMirror(capability)) {
    issues.push(
      `${capability.owner} contract test root ${capability.contractTestRoot} must mirror ` +
        capability.skillRoot,
    );
  }
  validateGuidanceCommand(issues, capability, input.packageScripts);
  if (
    capability.evaluationRoot !== undefined &&
    capability.evaluationRoot !== null &&
    !hasFileUnder(repositoryFileSet, capability.evaluationRoot)
  ) {
    issues.push(
      `${capability.owner} evaluation root ${capability.evaluationRoot} contains no ` +
        'repository files',
    );
  }
  for (const contractPath of capability.contractPaths ?? []) {
    if (!repositoryFileSet.has(contractPath)) {
      issues.push(`${capability.owner} contract path ${contractPath} does not resolve`);
    }
  }
}

function validateGuidanceCommand(issues, capability, packageScripts) {
  const commandMatch = /^npm run ([a-z0-9:-]+)$/u.exec(capability.focusedCommand);
  const resolvedCommand = commandMatch && packageScripts[commandMatch[1]];
  const expectedCommand = `vitest run ${capability.contractTestRoot}`;
  if (resolvedCommand !== expectedCommand) {
    issues.push(
      `${capability.owner} focused command ${capability.focusedCommand} must resolve exactly ` +
        `to ${expectedCommand}`,
    );
  }
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
    if (
      !isCapabilitySourcePath(capability, sourcePath) &&
      !(capability.factContracts ?? []).includes(sourcePath)
    ) {
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

function validateColdNavigationEvidence(coldNavigationValidation) {
  const { issues, input, authoredFileSet, repositoryFileSet } = coldNavigationValidation;
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
    } else if (capability.kind === 'guidance') {
      if (!isGuidanceRepositoryPath(capability, probe.path)) {
        issues.push(`cold-navigation probe path ${probe.path} is outside ${probe.capabilityOwner}`);
      } else if (!repositoryFileSet.has(probe.path)) {
        issues.push(`cold-navigation probe path ${probe.path} does not resolve`);
      }
      continue;
    } else if (!isCapabilitySourcePath(capability, probe.path)) {
      issues.push(`cold-navigation probe path ${probe.path} is outside ${probe.capabilityOwner}`);
      continue;
    }
    validateSourceReference({
      issues,
      input,
      authoredFiles: authoredFileSet,
      sourcePath: probe.path,
      symbol: probe.symbol,
      prefix: 'cold-navigation probe',
    });
  }
}

function isGuidanceRepositoryPath(capability, repositoryPath) {
  return (
    repositoryPath === capability.skillEntry ||
    repositoryPath === capability.evaluationRoot ||
    repositoryPath === capability.contractTestRoot ||
    repositoryPath.startsWith(`${capability.skillRoot}/`) ||
    (typeof capability.evaluationRoot === 'string' &&
      repositoryPath.startsWith(`${capability.evaluationRoot}/`)) ||
    repositoryPath.startsWith(`${capability.contractTestRoot}/`) ||
    (capability.contractPaths ?? []).includes(repositoryPath)
  );
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
  const evidence =
    typeof source === 'string'
      ? readTopLevelSymbolEvidence(reference.sourcePath, source)
      : { status: 'resolved', symbols: new Set() };
  if (evidence.status === 'unsupported') {
    const extension = path.posix.extname(reference.sourcePath).toLowerCase();
    reference.issues.push(
      `${reference.prefix} symbol evidence for ${reference.sourcePath} uses unsupported ` +
        `language ${extension || '(none)'}`,
    );
    return;
  }
  if (evidence.status === 'malformed-shell') {
    reference.issues.push(
      `${reference.prefix} symbol evidence for ${reference.sourcePath} is unresolvable because ` +
        'shell scope is malformed or unbalanced',
    );
    return;
  }
  if (
    typeof reference.symbol !== 'string' ||
    reference.symbol.trim() === '' ||
    !evidence.symbols.has(reference.symbol)
  ) {
    reference.issues.push(
      `${reference.prefix} symbol ${reference.symbol} is not a navigable top-level owner in ` +
        reference.sourcePath,
    );
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

export function readTopLevelSymbolEvidence(file, source) {
  const extension = path.posix.extname(file).toLowerCase();
  if (!supportedSymbolExtensions.has(extension)) {
    return { status: 'unsupported', symbols: new Set() };
  }
  if (extension === '.py') {
    return { status: 'resolved', symbols: pythonTopLevelSymbols(source) };
  }
  if (extension === '.sh') {
    return shellTopLevelSymbolEvidence(source);
  }
  try {
    const plugins = file.endsWith('x') ? ['typescript', 'jsx'] : ['typescript'];
    const program = parse(source, { sourceType: 'module', plugins }).program;
    return { status: 'resolved', symbols: collectTopLevelJavaScriptNames(program.body) };
  } catch {
    return { status: 'resolved', symbols: new Set() };
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

function shellTopLevelSymbolEvidence(source) {
  const names = new Set();
  const scope = {
    braceDepth: 0,
    pendingFunctionBody: false,
    quote: null,
    escaped: false,
  };
  for (const line of source.split(/\r?\n/u)) {
    if (!collectShellTopLevelDeclaration(line, scope, names) || !advanceShellScope(line, scope)) {
      return { status: 'malformed-shell', symbols: new Set() };
    }
  }
  return scope.braceDepth === 0 && scope.quote === null && !scope.pendingFunctionBody
    ? { status: 'resolved', symbols: names }
    : { status: 'malformed-shell', symbols: new Set() };
}

function collectShellTopLevelDeclaration(line, scope, names) {
  if (scope.quote !== null || scope.braceDepth !== 0) {
    return true;
  }
  const trimmed = line.trimStart();
  if (scope.pendingFunctionBody) {
    if (trimmed === '' || trimmed.startsWith('#')) {
      return true;
    }
    scope.pendingFunctionBody = false;
    return trimmed.startsWith('{');
  }
  const declaration =
    /^(?:function\s+([A-Za-z_]\w*)\s*(?:\(\s*\))?|([A-Za-z_]\w*)\s*\(\s*\))\s*(.*)$/u.exec(trimmed);
  if (declaration === null) {
    const assignment = /^(?:export\s+|readonly\s+)?([A-Za-z_]\w*)=/u.exec(trimmed);
    if (assignment !== null) {
      names.add(assignment[1]);
    }
    return true;
  }
  names.add(declaration[1] ?? declaration[2]);
  const remainder = declaration[3].trimStart();
  scope.pendingFunctionBody = remainder === '';
  return remainder === '' || remainder.startsWith('{');
}

function advanceShellScope(line, scope) {
  for (const character of line) {
    if (scope.escaped) {
      scope.escaped = false;
      continue;
    }
    if (scope.quote === "'") {
      if (character === "'") {
        scope.quote = null;
      }
      continue;
    }
    if (scope.quote === '"') {
      if (character === '\\') {
        scope.escaped = true;
      } else if (character === '"') {
        scope.quote = null;
      }
      continue;
    }
    if (character === '\\') {
      scope.escaped = true;
    } else if (character === "'" || character === '"') {
      scope.quote = character;
    } else if (character === '#') {
      break;
    } else if (character === '{') {
      scope.braceDepth += 1;
    } else if (character === '}') {
      scope.braceDepth -= 1;
      if (scope.braceDepth < 0) {
        return false;
      }
    }
  }
  return true;
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

function isRecognizedGuidanceTestMirror(capability) {
  const ownerNames = new Set([path.posix.basename(capability.skillRoot)]);
  if (typeof capability.evaluationRoot === 'string') {
    const evaluationParts = capability.evaluationRoot.split('/');
    if (evaluationParts[0] === '.agents' && evaluationParts[1] === 'evaluations') {
      ownerNames.add(evaluationParts[2]);
    }
  }
  return [...ownerNames].some((ownerName) =>
    [`packages/tests/repo/${ownerName}`, `tests/repo/${ownerName}`].includes(
      capability.contractTestRoot,
    ),
  );
}

function isTestModuleUnder(file, testRoot) {
  return (
    file.startsWith(`${testRoot}/`) && /[.-](?:test|spec)\.[^.]+$/u.test(path.posix.basename(file))
  );
}
