import type { AuthTestAstNode, ParsedAuthTestSource } from './auth-server-test-ast.ts';
import type { AuthTestBindingResolver } from './auth-server-test-expression-canonicalization.ts';
import type { AuthTestSourceModule } from './auth-server-test-module-graph.ts';

export type AuthTestSemanticFactKind =
  | 'assertion'
  | 'declaration'
  | 'mutation-expression'
  | 'numeric-literal'
  | 'regex-literal'
  | 'registration'
  | 'setup-expression'
  | 'string-literal';

export interface AuthTestSemanticFact {
  readonly kind: AuthTestSemanticFactKind;
  readonly value: string;
}

export interface AuthTestSemanticRead {
  readonly facts: readonly AuthTestSemanticFact[];
  readonly issues: readonly string[];
}

export interface ReadRegistrationFactsInput {
  readonly parsed: ParsedAuthTestSource;
  readonly modules: readonly AuthTestSourceModule[];
  readonly canonicalize: (expression: AuthTestAstNode) => string;
  readonly canonicalizeAssertion: (
    expression: AuthTestAstNode,
    resolveBinding: AuthTestBindingResolver,
  ) => string;
  readonly resolveString: (expression: AuthTestAstNode) => string | undefined;
}
