import { createHash } from 'node:crypto';

import {
   calleeName,
   containsReadCall,
   isAstParserCall,
   isFunctionExpression,
   isProductionPath,
   isReadCall,
   memberPropertyName,
   readTestSourceDataflow,
   usesSource,
   walkSyntaxTree
} from './test-structure-coupling-source-dataflow.mjs';

export function scanSources(sources) {
   const candidates = [];
   const errors = [];
   const reviewedPaths = [];
   for (const { file, source } of sources) {
      const result = scanTestSource(file, source);
      candidates.push(...result.candidates);
      errors.push(...result.errors);
      if (result.errors.length === 0) {
         reviewedPaths.push(file);
      }
   }
   return {
      candidates: candidates.toSorted(compareCandidates),
      errors: errors.toSorted(),
      reviewedPaths: reviewedPaths.toSorted()
   };
}

function scanTestSource(file, source) {
   try {
      const dataflow = readTestSourceDataflow({ file, source });
      const blockCandidates = dataflow.blocks.flatMap((block) =>
         scanBlock({ file, source, block, context: dataflow.context })
      );
      return { candidates: toIdentifiedCandidates(file, blockCandidates), errors: [] };
   }
   catch (error) {
      return { candidates: [], errors: [toParseError(file, error)] };
   }
}

function toParseError(file, error) {
   const message = error instanceof Error ? error.message : String(error);
   const reason = message
      .replaceAll(/[\u0000-\u001f\u007f]/gu, ' ')
      .replaceAll(/\s+/gu, ' ')
      .trim()
      .slice(0, 240);
   return `supported test source could not be parsed: ${file}: ${reason || 'unknown parser error'}`;
}

function scanBlock({ file, source, block, context }) {
   const candidates = [];
   const sourceValues = new Set();
   const dynamicPaths = new Set(context.paths);
   walkSyntaxTree(block, (node, parent) => {
      recordDynamicPath({ node, context, dynamicPaths });
      if (node.type !== 'CallExpression') {
         return;
      }
      const callEvidence = { file, source, node, parent, context, sourceValues, dynamicPaths };
      candidates.push(...readSourceFlowCandidates(callEvidence));
      candidates.push(...readStructureCandidates(callEvidence));
      candidates.push(...readAssertionCandidates(callEvidence));
      candidates.push(...readHighSignalTestCouplingCandidates(callEvidence));
   });
   return candidates;
}

function recordDynamicPath({ node, context, dynamicPaths }) {
   if (
      node.type === 'ForOfStatement' &&
      node.left.type === 'VariableDeclaration' &&
      node.left.declarations[0]?.id.type === 'Identifier' &&
      isProductionPath(node.right, dynamicPaths, context.arrays)
   ) {
      dynamicPaths.add(node.left.declarations[0].id.name);
   }
   if (
      node.type === 'CallExpression' &&
      node.callee.type === 'MemberExpression' &&
      ['map', 'flatMap', 'forEach'].includes(memberPropertyName(node.callee)) &&
      isProductionPath(node.callee.object, dynamicPaths, context.arrays)
   ) {
      const callback = node.arguments.find(isFunctionExpression);
      const parameter = callback?.params[0];
      if (parameter?.type === 'Identifier') {
         dynamicPaths.add(parameter.name);
      }
   }
}

function readSourceFlowCandidates(evidence) {
   const { node, parent, context, sourceValues, dynamicPaths } = evidence;
   const candidates = [];
   const callee = calleeName(node.callee);
   const firstArgument = node.arguments[0];
   if (
      isReadCall(callee, context) &&
      firstArgument &&
      isProductionPath(firstArgument, dynamicPaths, context.arrays)
   ) {
      candidates.push(
         createCandidate({
            ...evidence,
            location: node.callee,
            kind: 'production-source-read',
            reason: 'reads production source text'
         })
      );
      recordSourceValue(parent, sourceValues);
   }
   if (
      isAstParserCall(callee, context) &&
      node.arguments.some(
         (argument) => usesSource(argument, sourceValues) || containsReadCall(argument, context)
      )
   ) {
      candidates.push(
         createCandidate({
            ...evidence,
            location: node.callee,
            kind: 'ast-inspection',
            reason: 'inspects a production source AST or parser model'
         })
      );
      recordSourceValue(parent, sourceValues);
   }
   return candidates;
}

function recordSourceValue(parent, sourceValues) {
   if (parent?.type === 'VariableDeclarator' && parent.id.type === 'Identifier') {
      sourceValues.add(parent.id.name);
   }
}

function readStructureCandidates(evidence) {
   const { node, context, sourceValues, dynamicPaths } = evidence;
   const candidates = [];
   const callee = calleeName(node.callee);
   const firstArgument = node.arguments[0];
   if (
      isTreeCall(callee) &&
      firstArgument &&
      isProductionPath(firstArgument, dynamicPaths, context.arrays)
   ) {
      candidates.push(
         createCandidate({
            ...evidence,
            location: node.callee,
            kind: 'exact-file-tree',
            reason: 'pins a production file tree or source inventory'
         })
      );
   }
   const derivedFromSource = node.arguments.some(
      (argument) => usesSource(argument, sourceValues) || containsReadCall(argument, context)
   );
   if ((isLineCountCall(callee) && derivedFromSource) || isSourceSplitLength(node, sourceValues)) {
      candidates.push(
         createCandidate({
            ...evidence,
            location: node.callee,
            kind: 'line-count',
            reason: 'pins a production source line count'
         })
      );
   }
   return candidates;
}

function readAssertionCandidates(evidence) {
   const { source, node, sourceValues } = evidence;
   const candidates = [];
   const callee = calleeName(node.callee);
   if (isAssertionCall(callee) && usesSource(node.callee, sourceValues)) {
      candidates.push(
         createCandidate({
            ...evidence,
            location: node.callee,
            kind: 'symbol-assertion',
            reason: 'pins a production symbol or source-text fragment'
         })
      );
      const text = source.slice(node.start, node.end);
      if (hasCompatibilityVocabulary(text)) {
         candidates.push(
            createCandidate({
               ...evidence,
               location: node.callee,
               kind: 'migration-or-compatibility-topology',
               reason: 'pins migration or compatibility implementation topology'
            })
         );
      }
   }
   if (isOrderAssertion(callee) && usesSource(node.callee, sourceValues)) {
      candidates.push(
         createCandidate({
            ...evidence,
            location: node.callee,
            kind: 'call-or-import-order',
            reason: 'pins production call or import order'
         })
      );
   }
   if (isHashOrSnapshot(callee) && usesSource(node, sourceValues)) {
      candidates.push(
         createCandidate({
            ...evidence,
            location: node.callee,
            kind: 'source-hash-or-snapshot',
            reason: 'pins a production source hash or snapshot'
         })
      );
   }
   return candidates;
}

function readHighSignalTestCouplingCandidates(evidence) {
   const { node, source } = evidence;
   const matcher = memberPropertyName(node.callee);
   const callSource = source.slice(node.start, node.end);
   const browserEvaluation = isBrowserEvaluationCall(node);
   const detections = [
      {
         matches: isMockInvocationMatcher(matcher) ||
            isCompleteMockCallsAssertion(matcher, callSource) ||
            isInvocationOrderAssertion(matcher, callSource),
         kind: 'mock-invocation-count-or-order',
         reason: 'pins mock invocation count or order'
      },
      {
         matches: browserEvaluation && hasHiddenBrowserCallLog(callSource),
         kind: 'browser-call-log',
         reason: 'uses a hidden browser call log to reconstruct collaborator execution'
      },
      {
         matches: browserEvaluation && monkeypatchesPlatformPrimitive(callSource),
         kind: 'platform-scheduling-or-history-probe',
         reason: 'monkeypatches browser history, scheduling, or worker topology'
      },
      {
         matches: isGeneratedArtifactIdentityAssertion(matcher, callSource),
         kind: 'generated-artifact-identity',
         reason: 'pins generated chunk or worker asset identity'
      }
   ];
   return detections
      .filter(({ matches }) => matches)
      .map(({ kind, reason }) => createCandidate({ ...evidence, location: node.callee, kind, reason }));
}

function isMockInvocationMatcher(matcher) {
   return [
      'toBeCalled',
      'toBeCalledTimes',
      'toHaveBeenCalled',
      'toHaveBeenCalledAfter',
      'toHaveBeenCalledBefore',
      'toHaveBeenCalledExactlyOnceWith',
      'toHaveBeenCalledOnce',
      'toHaveBeenCalledTimes',
      'toHaveBeenLastCalledWith',
      'toHaveBeenNthCalledWith'
   ].includes(matcher);
}

function isCompleteMockCallsAssertion(matcher, callSource) {
   return (
      ['toEqual', 'toStrictEqual'].includes(matcher) &&
      /\.mock\s*\.\s*calls\b/u.test(callSource)
   );
}

function isInvocationOrderAssertion(matcher, callSource) {
   return (
      ['toBeLessThan', 'toBeLessThanOrEqual', 'toBeGreaterThan', 'toBeGreaterThanOrEqual'].includes(
         matcher
      ) &&
      /\.mock\s*\.\s*invocationCallOrder\b/u.test(callSource)
   );
}

function isBrowserEvaluationCall(node) {
   return ['addInitScript', 'evaluate', 'evaluateHandle'].includes(memberPropertyName(node.callee));
}

function hasHiddenBrowserCallLog(source) {
   return /(?:window|globalThis)\s*(?:\.\s*|\[\s*['"])__[A-Za-z0-9_$]*(?:CallLog|Calls|Invocations)\b/u.test(
      source
   );
}

function monkeypatchesPlatformPrimitive(source) {
   const replacesPrimitive = /history\s*\.\s*(?:pushState|replaceState)\s*=/u.test(source) ||
      /Object\s*\.\s*defineProperty\s*\(\s*(?:window\s*\.\s*)?history\s*,\s*['"](?:pushState|replaceState)['"]/u.test(
         source
      ) ||
      /(?:window|globalThis)\s*\.\s*(?:setTimeout|setInterval|clearTimeout|clearInterval|requestAnimationFrame|cancelAnimationFrame|Worker)\s*=/u
         .test(
            source
         ) ||
      /Object\s*\.\s*defineProperty\s*\(\s*(?:window|globalThis)\s*,\s*['"](?:setTimeout|setInterval|clearTimeout|clearInterval|requestAnimationFrame|cancelAnimationFrame|Worker)['"]/u
         .test(
            source
         );
   return replacesPrimitive &&
      /(?:__[A-Za-z0-9_$]*(?:Probe|CallLog|Calls|Invocations)|\b(?:activeTimers?|activeIntervals?|callLog|invocationOrder|scheduledCalls?)\b)/iu
         .test(source);
}

function isGeneratedArtifactIdentityAssertion(matcher, source) {
   if (!['toBe', 'toContain', 'toEqual', 'toMatch', 'toStrictEqual'].includes(matcher)) {
      return false;
   }
   return /['"][^'"]*(?:(?:worker|chunk)[^'"]*\.m?js|(?:index|main|app)[.-][a-z0-9_-]{5,}\.m?js)(?:[?#][^'"]*)?['"]/iu
      .test(
         source
      );
}

function isTreeCall(name) {
   return /(?:readdir(?:Sync)?|glob|ls-tree|find)$/u.test(name);
}

function isLineCountCall(name) {
   return /(?:physicalLineCount|lineCount|countLines)$/u.test(name);
}

function isAssertionCall(name) {
   return /(?:toContain|toMatch|toEqual|toStrictEqual|includes)$/u.test(name);
}

function isOrderAssertion(name) {
   return /(?:toBeLessThan|toBeGreaterThan)$/u.test(name);
}

function isHashOrSnapshot(name) {
   return /(?:createHash|digest|toMatchSnapshot|toMatchInlineSnapshot)$/u.test(name);
}

function hasCompatibilityVocabulary(text) {
   return /(?:migration|compat(?:ibility)?|legacy|deprecated|fallback|shim|bridge|rollback)/iu.test(
      text
   );
}

function isSourceSplitLength(node, sourceValues) {
   if (calleeName(node.callee) !== 'expect') {
      return false;
   }
   const counted = node.arguments[0];
   if (counted?.type !== 'MemberExpression' || memberPropertyName(counted) !== 'length') {
      return false;
   }
   const split = counted.object;
   return (
      split?.type === 'CallExpression' &&
      memberPropertyName(split.callee) === 'split' &&
      usesSource(split.callee.object, sourceValues)
   );
}

function createCandidate({ file, source, location, kind, reason }) {
   const detail = source.slice(location.start, location.end).replaceAll(/\s+/gu, ' ').trim();
   return {
      path: file,
      line: location.loc.start.line,
      column: location.loc.start.column + 1,
      kind,
      reason,
      semanticKey: `${kind}\0${detail}`
   };
}

// The identity is deliberately free of line and column. `semanticKey` already carries the
// whitespace-normalized detail, so a reformat that moves an occurrence must not re-key it and
// invalidate its registered review. Repeated identical coupling inside one file is separated by
// occurrence order, which reformatting preserves.
function toIdentifiedCandidates(file, candidates) {
   const occurrenceBySemanticKey = new Map();
   return candidates
      .toSorted((left, right) => left.line - right.line || left.column - right.column)
      .map((candidate) => {
         const occurrence = occurrenceBySemanticKey.get(candidate.semanticKey) ?? 0;
         occurrenceBySemanticKey.set(candidate.semanticKey, occurrence + 1);
         const id = createHash('sha256')
            .update(`${file}\0${candidate.semanticKey}\0${occurrence}`)
            .digest('hex')
            .slice(0, 16);
         return { ...candidate, id: `test-structure-coupling-${id}` };
      });
}

export function isTestPath(file) {
   const isTestLocation = /(?:^|\/)(?:tests?|__tests__)(?:\/|$)/u.test(file) ||
      /\.(?:test|spec)\.[cm]?[jt]sx?$/u.test(file);
   return isTestLocation && /\.(?:[cm]?js|jsx|[cm]?ts|tsx)$/u.test(file);
}

export function compareCandidates(left, right) {
   const leftKey = `${left.path}:${left.line}:${left.column}:${left.kind}:${left.id}`;
   const rightKey = `${right.path}:${right.line}:${right.column}:${right.kind}:${right.id}`;
   return leftKey.localeCompare(rightKey);
}
