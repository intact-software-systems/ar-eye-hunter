# TypeScript API Test Decoupling Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remove the eight test suites' direct dependency on the TypeScript compiler API while preserving the valuable public API, browser boundary, protocol, persistence, and architectural checks.

**Architecture:** Add one test-only `@babel/parser` adapter that returns immutable, parser-neutral records for imports, exports, dynamic imports, declarations, identifiers, and relative dependency graphs. Port the five durable suites to those records, then replace the three migration-era fingerprint suites with one compact legacy-boundary suite.

**Tech Stack:** TypeScript, Vitest, `@babel/parser`, Node `fs`/`path`, npm workspaces.

## Global Constraints

- Do not upgrade TypeScript or change any `tsconfig.json`.
- Do not change production runtime behavior or public package exports.
- Keep Babel AST types private to the test helper.
- Preserve all behavioral tests in the retention and history suites.
- Add the compact replacement coverage and see it pass before deleting the three legacy fingerprint suites.
- Preserve unrelated working-tree changes; stage only files listed by each task.

---

### Task 1: Declare and test the parser-neutral source-analysis helper

**Files:**

- Modify: `package.json`
- Modify: `package-lock.json`
- Create: `packages/tests/helpers/source-analysis.test.ts`
- Create: `packages/tests/helpers/source-analysis.ts`

- [ ] **Step 1: Declare the direct development dependency**

Run:

```bash
npm install --save-dev @babel/parser@7.29.3
```

Expected: `package.json` adds only `@babel/parser` under `devDependencies`; lockfile changes only declare the direct dependency and necessary lock metadata. The existing TypeScript entry stays unchanged.

- [ ] **Step 2: Write failing parser-normalization tests**

Create fixtures in `source-analysis.test.ts` that import the not-yet-created helper and cover:

```ts
import {
  analyzeSource,
  buildRelativeTypeScriptGraph,
  findDependencyCycles,
  resolveRelativeTypeScriptDependency,
} from './source-analysis';
```

The fixture must include all syntax that retained consumers need:

```ts
import DefaultThing, { type Config, runtime as renamed } from './mixed';
import type * as Types from './types';
import './side-effect';
export { type PublicType, runtimeValue as publicValue } from './public';
export * from './star';
export * as namespaceExport from './namespace';
export interface PublicInterface {}
export const publicConstant = localStorage;
const lazyLiteral = import('./lazy');
const lazyExpression = import(target);
```

Assert normalized records rather than Babel node shapes:

```ts
expect(analysis.imports).toContainEqual({
  specifier: './mixed',
  typeOnly: false,
  sideEffectOnly: false,
  defaultImport: 'DefaultThing',
  namespaceImport: undefined,
  namedImports: [
    { imported: 'Config', local: 'Config', typeOnly: true },
    { imported: 'runtime', local: 'renamed', typeOnly: false },
  ],
});
expect(analysis.dynamicImports).toEqual([
  { specifier: './lazy', literal: true },
  { specifier: undefined, literal: false },
]);
expect(analysis.identifierNames).toContain('localStorage');
```

Use a temporary fixture directory for extension and index resolution (`.ts`, `.tsx`, `/index.ts`) and an in-memory graph for cycle reporting.

- [ ] **Step 3: Confirm the new tests fail for the expected reason**

Run:

```bash
npx vitest run packages/tests/helpers/source-analysis.test.ts
```

Expected: FAIL because `./source-analysis` does not exist. Do not proceed if the failure is unrelated.

- [ ] **Step 4: Implement the narrow helper**

Export plain immutable types and functions:

```ts
export type SourceNamedImport = Readonly<{
  imported: string;
  local: string;
  typeOnly: boolean;
}>;

export type SourceImport = Readonly<{
  specifier: string;
  typeOnly: boolean;
  sideEffectOnly: boolean;
  defaultImport?: string;
  namespaceImport?: string;
  namedImports: readonly SourceNamedImport[];
}>;

export type SourceExport = Readonly<{
  kind: 'named' | 'star' | 'namespace' | 'declaration' | 'default';
  exportedName?: string;
  localName?: string;
  specifier?: string;
  typeOnly: boolean;
}>;

export type SourceDeclaration = Readonly<{
  name: string;
  kind: 'value' | 'type' | 'class';
  exported: boolean;
  defaultExport: boolean;
}>;

export type SourceAnalysis = Readonly<{
  imports: readonly SourceImport[];
  exports: readonly SourceExport[];
  dynamicImports: readonly Readonly<{ specifier?: string; literal: boolean }>[];
  topLevelDeclarations: readonly SourceDeclaration[];
  identifierNames: readonly string[];
}>;

export function analyzeSource(source: string, filePath: string): SourceAnalysis;
export function analyzeSourceFile(filePath: string): SourceAnalysis;
export function resolveRelativeTypeScriptDependency(
  importerPath: string,
  specifier: string,
): string | undefined;
export function buildRelativeTypeScriptGraph(
  entryPaths: readonly string[],
): ReadonlyMap<string, readonly string[]>;
export function findDependencyCycles(
  graph: ReadonlyMap<string, readonly string[]>,
): readonly (readonly string[])[];
```

Implementation rules:

- Parse with `sourceType: 'module'`, `plugins: ['typescript', 'jsx']`, and `createImportExpressions: true`.
- Normalize only syntax required by the tests; do not expose parser nodes.
- Walk parser nodes with a small private recursive visitor, skipping location metadata.
- Include repository-relative file context in parse failures.
- Resolve only relative specifiers, testing exact files plus `.ts`, `.tsx`, `.mts`, `.cts`, and `index` variants.
- Traverse only resolved relative TypeScript dependencies and report deterministic, canonicalized cycles.

- [ ] **Step 5: Run the focused helper tests**

Run:

```bash
npx vitest run packages/tests/helpers/source-analysis.test.ts
```

Expected: PASS.

- [ ] **Step 6: Commit the helper**

```bash
git add package.json package-lock.json packages/tests/helpers/source-analysis.ts packages/tests/helpers/source-analysis.test.ts
git commit -m "test: add parser-neutral source analysis"
```

---

### Task 2: Port shared-web import and browser-entrypoint boundaries

**Files:**

- Modify: `packages/tests/shared-web/shared-web-app-import-boundaries.test.ts`
- Modify: `packages/tests/shared-web/shared-web-browser-entrypoints.test.ts`

- [ ] **Step 1: Replace compiler-shaped local helpers**

Remove `import ts from 'typescript'` and local AST traversal. Import only parser-neutral functions and records:

```ts
import { analyzeSourceFile } from '../helpers/source-analysis';
```

Map existing expectations to normalized data:

```ts
const valueImports = analysis.imports.filter((entry) => !entry.typeOnly);
const importedSpecifiers = valueImports.map((entry) => entry.specifier);
const runtimeExports = analysis.exports.filter((entry) => !entry.typeOnly);
```

Preserve the current assertions for:

- app imports staying on intended public/browser package surfaces;
- runtime versus type-only imports;
- browser entrypoint runtime exports;
- forbidden internal runtime imports and barrel reachability;
- string-literal dynamic imports where currently required.

- [ ] **Step 2: Run both focused suites**

```bash
npx vitest run \
  packages/tests/shared-web/shared-web-app-import-boundaries.test.ts \
  packages/tests/shared-web/shared-web-browser-entrypoints.test.ts
```

Expected: PASS with the same test count and assertions unless one compiler-specific fixture is intentionally replaced by an equivalent normalized assertion.

- [ ] **Step 3: Commit the port**

```bash
git add packages/tests/shared-web/shared-web-app-import-boundaries.test.ts packages/tests/shared-web/shared-web-browser-entrypoints.test.ts
git commit -m "test: decouple shared-web boundary checks from TypeScript API"
```

---

### Task 3: Port shared-web public API snapshots

**Files:**

- Modify: `packages/tests/shared-web/shared-web-public-api-snapshots.test.ts`

- [ ] **Step 1: Replace TypeScript export collection**

Remove the TypeScript compiler import and collect the existing snapshot model from `SourceAnalysis.exports` and `topLevelDeclarations`.

Keep stable sorting and the existing distinctions:

```ts
const namedExports = analysis.exports
  .filter((entry) => entry.kind === 'named')
  .map(({ exportedName, localName, specifier, typeOnly }) => ({
    exportedName,
    localName,
    specifier,
    typeOnly,
  }))
  .sort(comparePublicExport);
```

Preserve wildcard, namespace, named, declaration, default, and type-only export representation. Do not rewrite snapshots just to match parser ordering; normalize before comparing.

- [ ] **Step 2: Run the public API snapshot suite**

```bash
npx vitest run packages/tests/shared-web/shared-web-public-api-snapshots.test.ts
```

Expected: PASS without updating the expected public API surface.

- [ ] **Step 3: Commit the port**

```bash
git add packages/tests/shared-web/shared-web-public-api-snapshots.test.ts
git commit -m "test: port shared-web API snapshots to source analysis"
```

---

### Task 4: Port retention and history ownership checks

**Files:**

- Modify: `packages/tests/rallar-black-box/recipe-console-control-retention-api.test.ts`
- Modify: `packages/tests/rallar-black-box/recipe-console-history-storage.test.ts`

- [ ] **Step 1: Port the retention suite's source-only assertions**

Leave all protocol, authorization, abort, validation, and retention behavior tests unchanged. Replace only the source-analysis helper at the end of the file:

```ts
const analysis = analyzeSourceFile(sourcePath);
const eagerValueTargets = analysis.imports
  .filter((entry) => !entry.typeOnly)
  .map((entry) => entry.specifier);
const lazyTargets = analysis.dynamicImports
  .filter((entry) => entry.literal)
  .map((entry) => entry.specifier);
```

Keep the same allowed/forbidden module expectations.

- [ ] **Step 2: Port the history suite's local-storage ownership assertion**

Leave persistence, validation, and failure-isolation behavior tests unchanged. Replace identifier traversal with:

```ts
const analysis = analyzeSourceFile(sourcePath);
expect(analysis.identifierNames).not.toContain('localStorage');
```

Retain the existing list of modules allowed or forbidden to own storage.

- [ ] **Step 3: Run both focused suites**

```bash
npx vitest run \
  packages/tests/rallar-black-box/recipe-console-control-retention-api.test.ts \
  packages/tests/rallar-black-box/recipe-console-history-storage.test.ts
```

Expected: PASS with all behavioral test counts preserved.

- [ ] **Step 4: Commit the port**

```bash
git add packages/tests/rallar-black-box/recipe-console-control-retention-api.test.ts packages/tests/rallar-black-box/recipe-console-history-storage.test.ts
git commit -m "test: remove TypeScript API from recipe console checks"
```

---

### Task 5: Replace migration fingerprints with durable legacy boundaries

**Files:**

- Create: `packages/tests/rallar-black-box/legacy-boundaries.test.ts`
- Delete: `packages/tests/rallar-black-box/legacy-shell-composition.test.ts`
- Delete: `packages/tests/rallar-black-box/legacy-shell-structure.test.ts`
- Delete: `packages/tests/rallar-black-box/app-structure.test.ts`
- Modify: `apps/rallar-black-box/docs/recipe-console-product-spec.md`

- [ ] **Step 1: Add the compact replacement suite while old suites still exist**

The replacement suite must contain four durable tests:

```ts
it('keeps Recipe Console free of static legacy implementation imports', () => {
  // Enumerate Recipe Console .ts/.tsx sources.
  // Reject normalized static import targets that enter ../legacy or /legacy/.
});

it('loads every registered legacy experience route dynamically', () => {
  // Reuse the current registered route/module table from app-structure.test.ts.
  // Require each module in string-literal dynamicImports.
  // Reject it from eager value imports.
});

it('keeps the reachable legacy TypeScript dependency graph acyclic', () => {
  const graph = buildRelativeTypeScriptGraph([legacyExperiencePath]);
  expect(findDependencyCycles(graph)).toEqual([]);
});

it('keeps application and legacy roots as composition boundaries', () => {
  // Reject top-level declarations ending Panel/Section in App and legacy root.
  // Reject direct imported local names ending Panel/Section in the legacy root.
  // Allow the explicit shell/context/controller composition imports.
});
```

Use the exact legacy route registration table already asserted by the old suite so the boundary test cannot silently omit an experience.

- [ ] **Step 2: Run the replacement alongside the old suites**

```bash
npx vitest run \
  packages/tests/rallar-black-box/legacy-boundaries.test.ts \
  packages/tests/rallar-black-box/legacy-shell-composition.test.ts \
  packages/tests/rallar-black-box/legacy-shell-structure.test.ts \
  packages/tests/rallar-black-box/app-structure.test.ts
```

Expected: PASS. If the new suite exposes a real current boundary violation, fix the test model or stop and report it; do not change production behavior under this task.

- [ ] **Step 3: Delete the three fingerprint suites**

Delete the old files only after Step 2 passes. Do not carry across exact JSX order, CSS byte fingerprints, hook counts, or extraction AST hashes.

- [ ] **Step 4: Update the active product-spec reference**

Replace the live documentation reference to `app-structure.test.ts` with `legacy-boundaries.test.ts`. Leave historical implementation plans unchanged.

- [ ] **Step 5: Run the surviving Rallar Black Box suites**

```bash
npx vitest run \
  packages/tests/rallar-black-box/legacy-boundaries.test.ts \
  packages/tests/rallar-black-box/recipe-console-control-retention-api.test.ts \
  packages/tests/rallar-black-box/recipe-console-history-storage.test.ts
```

Expected: PASS.

- [ ] **Step 6: Commit the replacement**

```bash
git add \
  packages/tests/rallar-black-box/legacy-boundaries.test.ts \
  packages/tests/rallar-black-box/legacy-shell-composition.test.ts \
  packages/tests/rallar-black-box/legacy-shell-structure.test.ts \
  packages/tests/rallar-black-box/app-structure.test.ts \
  apps/rallar-black-box/docs/recipe-console-product-spec.md
git commit -m "test: replace legacy migration fingerprints with boundaries"
```

---

### Task 6: Verify the complete decoupling and guard the non-goals

**Files:**

- Verify all files changed in Tasks 1–5.
- Do not modify production or TypeScript configuration to make verification pass.

- [ ] **Step 1: Prove no TypeScript compiler API imports remain in tests**

```bash
rg -n "from ['\"]typescript['\"]|require\(['\"]typescript['\"]\)" packages/tests
```

Expected: no matches.

- [ ] **Step 2: Run the helper and all five retained/replacement test groups**

```bash
npx vitest run \
  packages/tests/helpers/source-analysis.test.ts \
  packages/tests/shared-web/shared-web-app-import-boundaries.test.ts \
  packages/tests/shared-web/shared-web-browser-entrypoints.test.ts \
  packages/tests/shared-web/shared-web-public-api-snapshots.test.ts \
  packages/tests/rallar-black-box/recipe-console-control-retention-api.test.ts \
  packages/tests/rallar-black-box/recipe-console-history-storage.test.ts \
  packages/tests/rallar-black-box/legacy-boundaries.test.ts
```

Expected: PASS.

- [ ] **Step 3: Run focused package checks**

```bash
npx tsc -p packages/shared-web/tsconfig.json --noEmit
npm --workspace @ar-eye-hunter/shared-web run check:browser-bundles
npm --workspace rallar-black-box run build
```

Expected: all PASS.

- [ ] **Step 4: Run the complete unit suite**

```bash
npm run test:unit
```

Expected: PASS. If unrelated pre-existing worktree changes fail tests, record the exact failures without altering those files.

- [ ] **Step 5: Prove the TypeScript dependency and configuration are unchanged**

Inspect only the task diff:

```bash
git diff f6bd4c4 -- package.json package-lock.json ':(glob)**/tsconfig*.json'
git diff --name-only f6bd4c4 -- ':(glob)**/tsconfig*.json'
```

Expected: `package.json`/lock show only the direct `@babel/parser` declaration; no `tsconfig` file appears and the TypeScript version text is unchanged.

- [ ] **Step 6: Review the scoped diff and working tree**

```bash
git diff --stat f6bd4c4
git status --short
```

Expected: task files match this plan; unrelated existing state-snapshot changes remain unstaged and untouched.

- [ ] **Step 7: Commit any final test-only correction**

If verification required a correction within task scope, stage only those task files and commit it. Otherwise leave the existing task commits intact.
