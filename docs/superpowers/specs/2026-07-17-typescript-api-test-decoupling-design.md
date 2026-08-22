# TypeScript API Test Decoupling Design

## Context

The repository currently has eight Vitest files that import the legacy
`typescript` programmatic API. None of the imports are used by application or
package runtime code. The dependency is confined to test-time source parsing,
AST traversal, import/export inspection, and one JSX transpilation used to
fingerprint extracted source.

The current eight files contain 162 passing tests. Their value is uneven:

| Test file                                                                      | Protected contract                                                                 | Decision                                        |
| ------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------- | ----------------------------------------------- |
| `packages/tests/shared-web/shared-web-app-import-boundaries.test.ts`           | Application imports stay on intentional browser/package surfaces                   | Retain and port                                 |
| `packages/tests/shared-web/shared-web-browser-entrypoints.test.ts`             | Browser entrypoints expose narrow runtime APIs and avoid internal runtime coupling | Retain and port                                 |
| `packages/tests/shared-web/shared-web-public-api-snapshots.test.ts`            | Shared-web public exports remain intentional and reviewable                        | Retain and port                                 |
| `packages/tests/rallar-black-box/recipe-console-control-retention-api.test.ts` | Retention protocol, authorization, abort, validation, and lazy-loading behavior    | Retain; replace only its source-analysis helper |
| `packages/tests/rallar-black-box/recipe-console-history-storage.test.ts`       | History persistence, validation, failure isolation, and local-storage ownership    | Retain; replace only its source-analysis helper |
| `packages/tests/rallar-black-box/legacy-shell-composition.test.ts`             | Exact legacy JSX composition, source inventory, and stylesheet bytes               | Replace with narrow boundary coverage           |
| `packages/tests/rallar-black-box/legacy-shell-structure.test.ts`               | Exact AST fingerprints and extraction topology                                     | Remove after replacement coverage exists        |
| `packages/tests/rallar-black-box/app-structure.test.ts`                        | Historical extraction ownership plus a few useful legacy/Recipe Console boundaries | Replace with narrow boundary coverage           |

## Goals

- Remove every direct `typescript` API import from the eight test files.
- Preserve public API, browser bundle, protocol, security, persistence, and
  architectural boundary checks that remain useful.
- Replace legacy implementation fingerprints with small tests for durable
  boundaries instead of preserving completed migration mechanics.
- Keep TypeScript and all TypeScript compiler configuration at their current
  versions and values.
- Leave production code unchanged.

## Non-Goals

- Upgrading TypeScript or preparing `tsconfig.json` files for TypeScript 7.
- Reproducing TypeScript's AST API through a compatibility facade.
- Preserving byte-identical legacy CSS, exact JSX child order, hook counts, or
  AST hashes from completed extraction work.
- Changing browser behavior, package exports, or runtime loading behavior.

## Architecture

Add one test-only source-analysis module under
`packages/tests/helpers/source-analysis.ts`. It will parse TypeScript and TSX
with `@babel/parser` and expose narrow, domain-oriented functions rather than
parser nodes:

- static imports with default, namespace, named, type-only, and side-effect
  metadata;
- static re-exports with named, namespace, wildcard, and type-only metadata;
- string-literal dynamic import targets;
- top-level exported declarations;
- identifier occurrence checks;
- relative TypeScript dependency resolution and reachable import graphs;
- dependency-cycle reporting.

Consumers receive immutable plain records and strings. No test outside the
helper imports Babel AST node types. This keeps future parser replacement local
and prevents another compiler-shaped compatibility dependency.

`@babel/parser` will become a direct root development dependency. It is already
present transitively through the Vite React plugin, but the tests must declare
their dependency explicitly.

## Retained Test Coverage

### Shared-web public and bundle boundaries

The three shared-web files retain their existing public export snapshots,
runtime export assertions, forbidden entrypoint checks, type-only versus
runtime import distinctions, internal-runtime barrel restrictions, and app
consumer import constraints. Their assertions will consume the shared helper's
plain source-analysis records.

### Retention and history behavior

All behavioral tests in the retention and history suites remain unchanged.
Only their final ownership/lazy-boundary source checks move to the shared
helper:

- eager value import and dynamic import discovery for retention modules;
- `localStorage` identifier ownership checks for history modules.

### Compact legacy boundaries

Replace the three implementation-fingerprint suites with one focused
`packages/tests/rallar-black-box/legacy-boundaries.test.ts` suite that proves:

1. Recipe Console source files do not statically import legacy implementation
   modules.
2. Registered legacy experience routes resolve through string-literal dynamic
   imports rather than eager value imports.
3. The legacy shell's reachable relative TypeScript import graph is acyclic.
4. The application root and legacy shell roots remain composition boundaries
   instead of directly owning the enumerated legacy feature panels.

These checks preserve the durable architectural intent without locking exact
component order, declaration text, internal hook topology, or migration-era
fingerprints.

## Error Handling

The parser helper throws an error containing the repository-relative path when
a source file cannot be parsed. Relative dependency resolution ignores package
imports and non-TypeScript assets, and reports unresolved relative TypeScript
edges in test output rather than silently inventing a target. Dynamic imports
with non-literal expressions are represented separately so boundary tests can
reject them when deterministic loading is required.

## Testing Strategy

Use test-driven development for the new helper:

1. Add focused helper tests covering TS/TSX imports, type-only forms,
   re-exports, dynamic imports, exported declarations, identifier detection,
   relative resolution, and cycle detection.
2. Run them before implementation and confirm failure because the helper does
   not exist.
3. Implement the smallest helper surface that passes.
4. Port the five retained suites incrementally and run each focused group.
5. Add the compact legacy boundary suite and verify it passes before deleting
   the three fingerprint suites.
6. Run all affected tests, the complete unit suite, shared-web type-check and
   bundle-boundary checks, and the Rallar Black Box build.
7. Verify no `typescript` imports remain under `packages/tests/**` and that no
   TypeScript dependency/version/configuration changed.

## Risks and Mitigations

- **Parser semantic differences:** Tests assert the normalized plain records,
  not Babel node shapes. Focused helper fixtures cover every syntax form used
  by the retained suites.
- **Lost legacy regression coverage:** Replacement tests are added and passing
  before the fingerprint suites are removed. Browser-facing behavior remains
  covered by existing Vitest and Playwright suites.
- **Accidental production coupling:** The helper stays under
  `packages/tests/helpers`, and `@babel/parser` is a root dev dependency only.
- **Accidental TS7 preparation:** Verification checks the TypeScript entries in
  all manifests plus every `tsconfig.json` diff; only parser-related dependency
  changes are allowed.
