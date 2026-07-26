import { parse } from '@babel/parser';

import {
  asCapabilityNode as asNode,
  type MutationBoundaryCapabilityAstNode as AstNode,
  walkCapabilityAst as walk,
} from './mutation-boundary-capability-ast.ts';
import {
  type CapabilityBindingAnalysis,
  capabilityExpressionKey,
  readCapabilityPropertyName,
  readDirectCapabilityMethod,
} from './mutation-boundary-capability-access.ts';
import { bindCapabilityNode } from './mutation-boundary-capability-provenance.ts';
import { createCapabilityTypeResolver } from './mutation-boundary-capability-types.ts';
import type { CapabilityTypeShape } from './mutation-boundary-capability-types.ts';
import { createCapabilityValueResolver } from './mutation-boundary-capability-values.ts';
import { findFlowSensitiveCapabilityCalls } from './mutation-boundary-capability-flow.ts';
import { createMutationBoundaryLexicalValues } from './mutation-boundary-lexical-values.ts';
import { evaluateStaticTruth } from './mutation-static-semantics.ts';

const READ_ONLY_CAPABILITY_METHODS = new Map<string, ReadonlySet<string>>([
  [
    'ClientStateRepository',
    new Set([
      'findInstance',
      'findPrincipal',
      'findSession',
      'findSessionEntry',
      'listEvents',
      'listRecentEvents',
      'listEventPage',
      'listAllSessions',
      'listInstances',
      'listPrincipals',
      'listSessions',
      'listSessionsForPrincipal',
      'listSnapshots',
      'readPresenceSnapshot',
      'readSnapshot',
    ]),
  ],
]);

export function findCapabilityMutationCalls(
  source: string,
  filePath: string,
): readonly string[] {
  const program = parse(source, {
    sourceType: 'module',
    sourceFilename: filePath,
    plugins: ['typescript', 'importAttributes'],
  }).program as AstNode;
  const resolver = createCapabilityTypeResolver(program, filePath);
  const lexical = createMutationBoundaryLexicalValues(program);
  const shapes = new Map<string, CapabilityTypeShape>();
  const analysis: CapabilityBindingAnalysis = {
    resolver,
    values: createCapabilityValueResolver(lexical, resolver, (key) => shapes.get(key)),
    bindings: lexical.bindings,
    lexical,
    receivers: new Map(),
    methods: new Map(),
    shapes,
    strings: new Map(),
  };
  const visitedStates = new Set<string>();
  while (true) {
    let changed = false;
    walk(program, (node) => {
      changed = bindCapabilityNode(node, analysis) || changed;
    });
    if (!changed) break;
    const state = capabilityStateKey(analysis);
    if (visitedStates.has(state)) break;
    visitedStates.add(state);
  }
  const calls = new Set<string>();
  for (
    const call of findFlowSensitiveCapabilityCalls(program, {
      definitionKey: (value) => {
        const node = asNode(value);
        const owner = analysis.bindings.thisKey(node);
        const name = readCapabilityPropertyName(
          node?.key,
          node?.computed === true,
          analysis,
        );
        return owner && name ? `${owner}.${name}` : '';
      },
      directMethod: (value) => readDirectCapabilityMethod(value, analysis),
      expressionKey: (value) => capabilityExpressionKey(value, analysis),
      fallbackMethod: (key) => analysis.methods.get(key),
      functionKey: (value) => analysis.bindings.functionKey(value),
      memberMethod: (sourceKey, property) => {
        const capability = analysis.receivers.get(sourceKey);
        return capability ? { capability, method: property } : undefined;
      },
      ownerFunctionKey: (value) => analysis.bindings.identifierFunctionKey(value),
      propertyName: (value, computed) => readCapabilityPropertyName(value, computed, analysis),
      lexical,
      staticTruth: (value) => evaluateStaticTruth(value, lexical),
    })
  ) {
    if (!READ_ONLY_CAPABILITY_METHODS.get(call.capability)?.has(call.method)) {
      calls.add(`${call.capability}.${call.method}`);
    }
  }
  return [...calls].toSorted();
}

function capabilityStateKey(analysis: CapabilityBindingAnalysis): string {
  const entries = <Value>(map: ReadonlyMap<string, Value>) =>
    [...map].toSorted(([left], [right]) => left.localeCompare(right));
  return JSON.stringify([
    entries(analysis.receivers),
    entries(analysis.methods),
    entries(analysis.shapes).map(([key]) => key),
    entries(analysis.strings),
  ]);
}
