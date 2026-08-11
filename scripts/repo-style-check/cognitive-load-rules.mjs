import { createRequire } from 'node:module';
import path from 'node:path';

// ts-morph loads lazily via require so checker runs without --cognitive-metrics
// (including the changed-findings gate) never pay for or depend on the parser.
const require = createRequire(import.meta.url);

export const cognitiveLoadTiers = [
  { minimum: 330, tier: 'refactor-or-register' },
  { minimum: 110, tier: 'review' },
  { minimum: 50, tier: 'warn' },
];
export const valueExportLimit = 12;
const measuredExtensions = new Set(['.ts', '.tsx', '.mts', '.cts']);

let memoizedTsMorph;
let memoizedProject;

export function isCognitiveMetricsFile(file) {
  const normalized = file.toLowerCase();
  return measuredExtensions.has(path.extname(normalized)) && !/\.d\.[cm]?ts$/u.test(normalized);
}

export function scanCognitiveMetricFindings(source) {
  const metrics = analyzeCognitiveMetrics(source.file, source.raw);
  const findings = [];
  const tier = resolveCognitiveLoadTier(metrics.cognitiveLoad);
  if (tier !== undefined) {
    findings.push({
      ruleId: 'file.cognitive-load',
      message: toCognitiveLoadMessage(metrics, tier),
    });
  }
  if (metrics.valueExportCount >= valueExportLimit) {
    findings.push({
      ruleId: 'file.responsibility-count',
      message:
        `File exports ${metrics.valueExportCount} runtime values ` +
        `(review threshold ${valueExportLimit}). A file owns one coherent responsibility; ` +
        'split unrelated exports along feature ownership.',
    });
  }
  return findings;
}

export function resolveCognitiveLoadTier(cognitiveLoad) {
  return cognitiveLoadTiers.find((candidate) => cognitiveLoad >= candidate.minimum)?.tier;
}

function toCognitiveLoadMessage(metrics, tier) {
  const worst = metrics.worstFunction;
  const worstDetail = worst.score > 0 ? `; worst function ${worst.name} scores ${worst.score}` : '';
  return (
    `File cognitive load ${metrics.cognitiveLoad} reaches the ${tier} tier ` +
    `(warn >= 50, review >= 110, refactor-or-register >= 330${worstDetail}). ` +
    'Split decision-dense responsibilities instead of growing this file.'
  );
}

export function analyzeCognitiveMetrics(file, raw) {
  const project = readAnalysisProject();
  const sourceFile = project.createSourceFile(
    `cognitive-metrics/${file.replaceAll('/', '__').replaceAll('\\', '__')}`,
    raw,
    { overwrite: true },
  );
  try {
    const cognitive = computeCognitiveComplexity(sourceFile);
    return {
      cognitiveLoad: cognitive.total,
      worstFunction: cognitive.worstFunction,
      functions: cognitive.functions,
      valueExportCount: computeValueExportCount(sourceFile),
    };
  } finally {
    project.removeSourceFile(sourceFile);
  }
}

function readTsMorph() {
  memoizedTsMorph ??= require('ts-morph');
  return memoizedTsMorph;
}

function readAnalysisProject() {
  const { Project } = readTsMorph();
  memoizedProject ??= new Project({
    skipAddingFilesFromTsConfig: true,
    skipFileDependencyResolution: true,
  });
  return memoizedProject;
}

function computeCognitiveComplexity(sourceFile) {
  const { SyntaxKind } = readTsMorph();
  const walk = {
    SyntaxKind,
    functionKinds: new Set([
      SyntaxKind.FunctionDeclaration,
      SyntaxKind.FunctionExpression,
      SyntaxKind.ArrowFunction,
      SyntaxKind.MethodDeclaration,
      SyntaxKind.Constructor,
      SyntaxKind.GetAccessor,
      SyntaxKind.SetAccessor,
    ]),
    logicalOperators: new Set([
      SyntaxKind.AmpersandAmpersandToken,
      SyntaxKind.BarBarToken,
      SyntaxKind.QuestionQuestionToken,
    ]),
    total: 0,
    scoreByFunction: new Map(),
  };
  visitForCognitiveLoad(walk, sourceFile, {
    nesting: 0,
    enclosingFunction: undefined,
    topFunction: undefined,
  });
  const functions = toFunctionScores(walk);
  return { total: walk.total, functions, worstFunction: resolveWorstFunction(functions) };
}

function visitForCognitiveLoad(walk, node, frame) {
  const kind = node.getKind();
  if (walk.functionKinds.has(kind)) {
    return visitFunctionNode(walk, node, frame);
  }
  if (kind === walk.SyntaxKind.IfStatement) {
    return visitIfStatement(walk, node, frame);
  }
  if (kind === walk.SyntaxKind.ConditionalExpression) {
    return visitConditionalExpression(walk, node, frame);
  }
  if (kind === walk.SyntaxKind.SwitchStatement) {
    return visitSwitchStatement(walk, node, frame);
  }
  if (isLoopStatement(walk.SyntaxKind, kind)) {
    return visitLoopStatement(walk, node, frame);
  }
  if (kind === walk.SyntaxKind.CatchClause) {
    return visitCatchClause(walk, node, frame);
  }
  if (isLabeledJump(walk.SyntaxKind, node, kind)) {
    return attribute(walk, 1, frame.topFunction);
  }
  if (isLogicalBinary(walk, node)) {
    return visitLogicalSequence(walk, node, frame);
  }
  node.forEachChild((child) => visitForCognitiveLoad(walk, child, frame));
}

function visitFunctionNode(walk, node, frame) {
  const bodyNesting = frame.enclosingFunction !== undefined ? frame.nesting + 1 : 0;
  node.forEachChild((child) =>
    visitForCognitiveLoad(walk, child, {
      nesting: bodyNesting,
      enclosingFunction: node,
      topFunction: frame.topFunction ?? node,
    }),
  );
}

function visitIfStatement(walk, node, frame) {
  const parent = node.getParent();
  const isElseIf =
    parent !== undefined &&
    parent.getKind() === walk.SyntaxKind.IfStatement &&
    parent.getElseStatement() === node;
  attribute(walk, isElseIf ? 1 : 1 + frame.nesting, frame.topFunction);
  visitForCognitiveLoad(walk, node.getExpression(), frame);
  visitForCognitiveLoad(walk, node.getThenStatement(), nested(frame));
  const elseStatement = node.getElseStatement();
  if (elseStatement === undefined) {
    return;
  }
  if (elseStatement.getKind() === walk.SyntaxKind.IfStatement) {
    visitForCognitiveLoad(walk, elseStatement, frame);
    return;
  }
  attribute(walk, 1, frame.topFunction);
  visitForCognitiveLoad(walk, elseStatement, nested(frame));
}

function visitConditionalExpression(walk, node, frame) {
  attribute(walk, 1 + frame.nesting, frame.topFunction);
  visitForCognitiveLoad(walk, node.getCondition(), frame);
  visitForCognitiveLoad(walk, node.getWhenTrue(), nested(frame));
  visitForCognitiveLoad(walk, node.getWhenFalse(), nested(frame));
}

function visitSwitchStatement(walk, node, frame) {
  attribute(walk, 1 + frame.nesting, frame.topFunction);
  visitForCognitiveLoad(walk, node.getExpression(), frame);
  for (const clause of node.getCaseBlock().getClauses()) {
    clause.forEachChild((child) => visitForCognitiveLoad(walk, child, nested(frame)));
  }
}

function visitLoopStatement(walk, node, frame) {
  attribute(walk, 1 + frame.nesting, frame.topFunction);
  node.forEachChild((child) => {
    const childFrame = child === node.getStatement() ? nested(frame) : frame;
    visitForCognitiveLoad(walk, child, childFrame);
  });
}

function visitCatchClause(walk, node, frame) {
  attribute(walk, 1 + frame.nesting, frame.topFunction);
  node.forEachChild((child) => visitForCognitiveLoad(walk, child, nested(frame)));
}

function visitLogicalSequence(walk, node, frame) {
  const parent = node.getParent();
  if (parent === undefined || !isLogicalBinary(walk, parent)) {
    const operators = [];
    collectLogicalOperators(walk, node, operators);
    attribute(walk, countOperatorAlternations(operators), frame.topFunction);
  }
  node.forEachChild((child) => visitForCognitiveLoad(walk, child, frame));
}

function collectLogicalOperators(walk, node, out) {
  const left = node.getLeft();
  const right = node.getRight();
  if (isLogicalBinary(walk, left)) {
    collectLogicalOperators(walk, left, out);
  }
  out.push(node.getOperatorToken().getKind());
  if (isLogicalBinary(walk, right)) {
    collectLogicalOperators(walk, right, out);
  }
}

function countOperatorAlternations(operators) {
  let alternations = 0;
  for (let index = 0; index < operators.length; index += 1) {
    if (index === 0 || operators[index] !== operators[index - 1]) {
      alternations += 1;
    }
  }
  return alternations;
}

function attribute(walk, amount, topFunction) {
  walk.total += amount;
  if (topFunction !== undefined) {
    walk.scoreByFunction.set(topFunction, (walk.scoreByFunction.get(topFunction) ?? 0) + amount);
  }
}

function nested(frame) {
  return { ...frame, nesting: frame.nesting + 1 };
}

function isLoopStatement(SyntaxKind, kind) {
  return (
    kind === SyntaxKind.ForStatement ||
    kind === SyntaxKind.ForInStatement ||
    kind === SyntaxKind.ForOfStatement ||
    kind === SyntaxKind.WhileStatement ||
    kind === SyntaxKind.DoStatement
  );
}

function isLabeledJump(SyntaxKind, node, kind) {
  return (
    (kind === SyntaxKind.BreakStatement || kind === SyntaxKind.ContinueStatement) &&
    node.getLabel() !== undefined
  );
}

function isLogicalBinary(walk, node) {
  return (
    node.getKind() === walk.SyntaxKind.BinaryExpression &&
    walk.logicalOperators.has(node.getOperatorToken().getKind())
  );
}

function toFunctionScores(walk) {
  return [...walk.scoreByFunction.entries()].map(([functionNode, score]) => ({
    name: resolveFunctionName(functionNode),
    startLine: functionNode.getStartLineNumber(),
    score,
  }));
}

function resolveFunctionName(functionNode) {
  const name = typeof functionNode.getName === 'function' ? functionNode.getName() : undefined;
  return name === undefined || name === '' ? functionNode.getKindName() : name;
}

function resolveWorstFunction(functions) {
  let worst = { name: undefined, startLine: 0, score: 0 };
  for (const candidate of functions) {
    if (candidate.score > worst.score) {
      worst = candidate;
    }
  }
  return worst;
}

function computeValueExportCount(sourceFile) {
  const { SyntaxKind } = readTsMorph();
  const typeOnlyDeclarations = new Set([
    SyntaxKind.InterfaceDeclaration,
    SyntaxKind.TypeAliasDeclaration,
  ]);
  let valueExports = 0;
  for (const statement of sourceFile.getStatements()) {
    const kind = statement.getKind();
    if (kind === SyntaxKind.ExportDeclaration) {
      valueExports += countNamedValueExports(statement);
      continue;
    }
    if (kind === SyntaxKind.ExportAssignment) {
      valueExports += 1;
      continue;
    }
    const hasExport =
      typeof statement.hasExportKeyword === 'function' && statement.hasExportKeyword();
    if (!hasExport || typeOnlyDeclarations.has(kind)) {
      continue;
    }
    valueExports += kind === SyntaxKind.VariableStatement ? statement.getDeclarations().length : 1;
  }
  return valueExports;
}

function countNamedValueExports(statement) {
  if (statement.isTypeOnly()) {
    return 0;
  }
  return statement.getNamedExports().filter((specifier) => !specifier.isTypeOnly()).length;
}
