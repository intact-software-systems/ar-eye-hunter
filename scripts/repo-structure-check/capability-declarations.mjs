import path from 'node:path';
import { parse } from '@babel/parser';

import { isProductionAuthoredCodePath } from './repository-files.mjs';

export function validateCapabilityDeclarations(input) {
  const authoredFileSet = new Set(input.authoredFiles);
  const issues = [];
  for (const capability of input.capabilities) {
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
    if (!hasFileUnder(authoredFileSet, capability.root)) {
      issues.push(`${capability.owner} root ${capability.root} contains no authored code`);
    }
    if (!authoredFileSet.has(capability.entry)) {
      issues.push(
        `${capability.owner} entry ${capability.entry} does not resolve to authored code`,
      );
    }
    if (!hasFileUnder(authoredFileSet, capability.testRoot)) {
      issues.push(
        `${capability.owner} test root ${capability.testRoot} contains no authored tests`,
      );
    }
    if (path.posix.basename(capability.testRoot) !== path.posix.basename(capability.root)) {
      issues.push(
        `${capability.owner} test root ${capability.testRoot} does not mirror ${capability.root}`,
      );
    }
    const commandMatch = /^npm run ([a-z0-9:-]+)$/u.exec(capability.focusedCommand);
    const resolvedCommand = commandMatch && input.packageScripts[commandMatch[1]];
    const expectedCommand = `vitest run ${capability.testRoot}`;
    if (resolvedCommand !== expectedCommand) {
      issues.push(
        `${capability.owner} focused command ${capability.focusedCommand} must resolve exactly ` +
          `to ${expectedCommand}`,
      );
    }
    for (const factContract of capability.factContracts ?? []) {
      if (!authoredFileSet.has(factContract)) {
        issues.push(
          `${capability.owner} fact contract ${factContract} does not resolve to authored code`,
        );
      }
    }
    const productionModuleCount = [...authoredFileSet].filter(
      (file) => file.startsWith(`${capability.root}/`) && isProductionAuthoredCodePath(file),
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
  validateColdNavigationEvidence(issues, input, authoredFileSet);
  return issues;
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
    !hasDeclaredSymbol(reference.sourcePath, source, reference.symbol)
  ) {
    reference.issues.push(
      `${reference.prefix} symbol ${reference.symbol} does not resolve in ${reference.sourcePath}`,
    );
  }
}

function hasDeclaredSymbol(file, source, symbol) {
  try {
    const plugins = file.endsWith('x') ? ['typescript', 'jsx'] : ['typescript'];
    const program = parse(source, { sourceType: 'module', plugins }).program;
    return collectDeclaredNames(program).has(symbol);
  } catch {
    return false;
  }
}

function collectDeclaredNames(program) {
  const names = new Set();
  walkAst(program, (node) => {
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
    } else if (node.type === 'VariableDeclarator' && node.id.type === 'Identifier') {
      names.add(node.id.name);
    }
  });
  return names;
}

function walkAst(node, visit) {
  if (Array.isArray(node)) {
    node.forEach((item) => walkAst(item, visit));
  } else if (node !== null && typeof node === 'object' && typeof node.type === 'string') {
    visit(node);
    Object.values(node).forEach((value) => walkAst(value, visit));
  }
}

function hasFileUnder(files, root) {
  return [...files].some((file) => file.startsWith(`${root}/`));
}
