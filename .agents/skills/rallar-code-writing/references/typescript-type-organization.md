# TypeScript Type Organization

This reference is TypeScript-specific and extends
[repo-code-style.md](./repo-code-style.md). It is authoritative for canonical type
naming, alias discipline, qualification, and type-only class namespaces. Local
guidance may tighten it but may not relax it, and it never relaxes the repo-wide
standard's construction, dataflow, or contract rules.

## Contents

- [Goal](#goal)
- [One canonical name per type](#one-canonical-name-per-type)
- [When a `type` alias is justified](#when-a-type-alias-is-justified)
- [Class-owned vocabulary uses an adjacent type-only namespace](#class-owned-vocabulary-uses-an-adjacent-type-only-namespace)
- [Associated namespaces are type-only](#associated-namespaces-are-type-only)
- [Erasable-syntax compatibility](#erasable-syntax-compatibility)
- [Deno-linted application trees](#deno-linted-application-trees)
- [Imports, re-exports, and module qualification](#imports-re-exports-and-module-qualification)
- [Refactoring existing aliases](#refactoring-existing-aliases)
- [Review heuristics](#review-heuristics)
- [Validation](#validation)

## Goal

The primary optimization goal is human comprehension. A reader should understand a
type reference where it appears, without following renaming aliases or mentally
reconstructing where a type came from. Every rule below exists to keep the name a
reader sees identical to the name the owning declaration uses, and to keep useful
ownership context attached to that name.

## One canonical name per type

Every named interface, class, enum, or named type has one canonical name: the name
at its declaration, qualified by its owning namespace when it has one. Use that
canonical name directly at every reference.

Do not create a local or exported alias whose only effect is to rename an existing
named type:

```ts
interface Account {
    readonly id: string;
}

type AccountDto = Account; // forbidden: rename alias
type AccountType = Account; // forbidden: rename alias
type LocalAccount = Account; // forbidden: rename alias
```

Do not strip qualification into a local alias:

```ts
type Input = CreateAccounts.Input; // forbidden: removes ownership context

function createAccount(input: Input): void {}
```

Use the canonical qualified name:

```ts
function createAccount(input: CreateAccounts.Input): void {}
```

Qualification is useful semantic information — it tells the reader which operation
owns the contract. Do not remove qualification merely to shorten code.

Renaming to describe a role is still a rename. An alias such as
`type OrderingSnapshot = PersistedOrderingState` forces the reader to follow the
alias to learn what the value actually is. Either use the canonical name at the
call site, or — when two roles genuinely must not be interchangeable — define a
distinct contract or a branded type so the type system enforces the difference.

## When a `type` alias is justified

The `type` construct is not prohibited. Use it when it defines a genuinely new
type expression or semantic type:

- discriminated or primitive unions;
- intersections used for intentional composition;
- mapped, conditional, `keyof`, and indexed-access types;
- tuples and function signatures;
- branded types;
- semantic primitive aliases such as `type VertexId = string` that name a domain
  concept the primitive alone does not carry.

```ts
type CreateAccountResult =
    | { readonly kind: 'success'; readonly value: Account; }
    | { readonly kind: 'failure'; readonly error: Error; };
```

Do not use `type` merely to rename an already understandable existing type or
qualified type, and do not create convenience aliases whose only purpose is
shortening syntax. The `interface`-versus-`type` choice itself is owned by the
[`interface` and `type` section of the repo standard](./repo-code-style.md#interface-and-type);
do not mechanically convert useful type expressions into awkward interfaces to
avoid the `type` keyword.

## Class-owned vocabulary uses an adjacent type-only namespace

When several contracts belong specifically to one class or operation, prefer a
type-only namespace with the same canonical name as the class, declared
immediately before the class:

```ts
export namespace CreateAccounts {
    export interface InputDto {
        readonly name: string;
    }

    export interface Read {
        readonly input: InputDto;
        readonly existingAccountCount: number;
    }

    export interface Computed {
        readonly read: Read;
        readonly accountId: string;
    }
}

export class CreateAccounts {
    read(input: CreateAccounts.InputDto): CreateAccounts.Read {
        return { input, existingAccountCount: 0 };
    }
}
```

The ordering is intentional: vocabulary and contracts first, implementation
second. A human encounters the types needed to understand the class before the
class body, and every reference — `CreateAccounts.InputDto` — carries its owner.

Keep declaration visibility consistent: an exported class pairs with an exported
namespace; a private class pairs with a private namespace.

This pattern composes with, and does not replace, the repo standard's contract
naming. The `Dto` suffix and the `input -> read -> computed -> written`
stage-record chain keep their established meaning whether the contract is flat or
namespace-qualified. Contracts owned by a function-based use case keep flat
feature-prefixed names such as `InvoiceInputDto` and `InvoiceRead`; do not
mechanically migrate existing flat contracts into namespaces, and do not introduce
a class merely to obtain a namespace.

## Associated namespaces are type-only

A namespace used for this pattern is a compile-time organizational container. It
contains only erasable type declarations: `interface`, `type`, and nested
type-only namespaces.

Do not put runtime behavior or runtime values into an associated namespace: no
functions, no initialized constants, no runtime classes, no enums. Runtime values
belong in ordinary module-level declarations, where the module itself is the
organizational unit.

Do not declare a namespace inside a class. Use adjacent class/namespace
declaration merging instead, with the namespace immediately before the class.

Existing runtime namespaces in the repository are legacy debt, not precedent.
Existing implementation is useful context but is not precedent when it violates
the standard; do not copy the runtime-namespace shape into new code, and do not
refactor legacy files outside a task that owns them.

## Erasable-syntax compatibility

Design new TypeScript toward `erasableSyntaxOnly` compatibility. Type-only
namespaces are erasable; runtime namespaces, TypeScript `enum`, and parameter
properties are not.

Verified against this repository's actual toolchain: with TypeScript 7.0.2 (the
pinned repo compiler), a type-only namespace declared immediately before its
merged class type-checks cleanly under `--strict` and under
`--erasableSyntaxOnly`, and a namespace containing runtime values fails
`--erasableSyntaxOnly` with TS1294. Deno 2.9.5 (`deno check`) accepts the
type-only pattern. Every repository tsconfig and deno.json enables
`erasableSyntaxOnly`, including `apps/rallar-black-box-control-server/deno.json`
now that its file-sourced Deno Deploy build accepts the option. The flag keeps
shared `packages/**` TypeScript portable across both runtimes and is an
enforced compiler setting, not merely a design target.

Do not introduce new TypeScript enums. For a type-only finite set, prefer a
string-literal union:

```ts
type AccountStatus = 'pending' | 'complete';
```

When runtime values are actually required, use normal JavaScript-compatible
constructs — exported `const` objects, functions, and classes at module level.
Do not change a good runtime design merely to force it into a namespace.

## Deno-linted application trees

`deno lint` with the `recommended` tag rejects every `namespace` declaration —
including type-only ones — via its `no-namespace` rule. This repository runs that
configuration over `apps/api-v1`, `apps/rallar-black-box-control-server`, and
`apps/relic-hunter-server-v1` (see the root `deno.json` lint include list and each
app's `deno.json`). `packages/**` is not in the Deno lint include list.

In those three Deno-owned trees, choose one of:

1. keep class-owned contracts as flat feature-prefixed interfaces adjacent to the
   class — the established shape, and the default; or
2. when qualified vocabulary genuinely improves comprehension, add a targeted
   suppression on the declaration:

```ts
// deno-lint-ignore no-namespace
export namespace GroupStateReplay {
    export interface InputDto {
        readonly groupRef: string;
    }
}
```

Do not exclude `no-namespace` from the Deno lint configuration wholesale: the rule
still usefully rejects runtime namespaces, which this standard also forbids.

## Imports, re-exports, and module qualification

Do not rename an import merely for convenience:

```ts
import { Account as BillingAccount } from './billing-account.ts'; // avoid
```

When two modules genuinely expose the same canonical leaf name, preserve the root
name through module qualification:

```ts
import * as Billing from './billing-account.ts';
import * as Identity from './identity-account.ts';

function compareAccounts(billing: Billing.Account, identity: Identity.Account): boolean {
    return billing.id === identity.id;
}
```

This keeps `Account` canonical while making its context explicit. A rename at an
import boundary is acceptable only when it resolves a real collision that module
qualification cannot express practically, and the new name must still contain the
canonical leaf name.

Do not create re-export aliases merely to introduce another name for the same
type. `mod.ts` package boundaries re-export canonical names; a compatibility
re-export under a different name requires the same explicit human approval and
documented lifetime as any other compatibility fallback.

## Refactoring existing aliases

When reviewing or refactoring TypeScript, actively identify aliases that add
indirection without adding semantics, and remove them in code the task already
touches:

```ts
type Input = CreateAccounts.Input; // remove

function createAccount(input: Input): void {}
```

becomes:

```ts
function createAccount(input: CreateAccounts.Input): void {}
```

For exported aliases that may be part of a public package surface, removal can be
a breaking change.

During touched-file standards closure, actively remove affected legacy code when no
independent requirement or verified consumer requires it. Do not retain affected legacy solely
because it pre-existed, a coupled test protects it, or removal was not named in the request. Keep
independent untouched legacy outside closure. If removal would change a public API, persisted
format, protocol, migration contract, or verified consumer behavior, treat it as a compatibility or
migration decision; minimize it to a thin named boundary and require explicit maintainer approval
and a registry entry for continued retention.

## Review heuristics

For every new named type, ask: does this name describe a genuinely new concept,
or is it another name for something that already has a canonical name? If it is
only another name, do not introduce it.

For every shortened qualified type, ask: did shortening make the code easier to
understand, or did it remove useful ownership context? Prefer explicit ownership
and context.

## Validation

`npm run check:repo-style` warns by default for the mechanical violations:
`types.rename-alias` flags a `type` alias whose right side is only a bare or
qualified type name (semantic primitive aliases such as `type VertexId = string`
stay unflagged), `types.runtime-namespace` flags namespaces containing runtime
members, and `types.enum-declaration` flags TypeScript enum declarations.
Declaration files (`*.d.ts`) are exempt because ambient declarations describe
externals. The full-repository run stays warning-only; the feature-branch gate
(`npm run check:repo-style:changed -- origin/main`) fails only new or worsened
findings per file and rule, so legacy debt never blocks unrelated branches.

Canonical-name choice, justified import renames, and namespace-before-class
ordering remain manual review. Validate changed surfaces with the focused
type-check for the touched package or app. In Deno-owned trees, `deno lint`
findings for `no-namespace` are expected unless a targeted suppression
accompanies a deliberate type-only namespace.
