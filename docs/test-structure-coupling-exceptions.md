# Test structure-coupling exception registry

`npm run check:test-structure-coupling` is an advisory review aid. It detects
tests coupled to production source text, file topology, ASTs, symbol spelling,
source hashes or snapshots, line counts, call/import order, and migration or
compatibility topology. A clean report does not prove that every test is
semantic; a candidate is a prompt for human review, not an automatic failure.

Production code remains the primary design artifact. Delete or replace an
incidental structural test with semantic coverage when production design
improves. Retain one only when it protects an independently stated durable
public, security, or compatibility boundary, or when it is a temporary ratchet
with a named owner and removal condition. Do not use this registry as a blanket
baseline or automatic grandfathering mechanism.

Each entry below identifies one currently detected candidate. `id`, `path`,
`line`, `column`, and `kind` must match the checker report exactly. Every entry
has a named `owner`; `rationale` explains the independent boundary or
short-lived risk; `semanticCoverage` names the test that proves behavior rather
than implementation shape. A `durable-boundary` entry additionally declares
`boundary` as `public`, `security`, or `compatibility`. A `temporary-ratchet`
entry additionally declares a non-empty `removalCondition`. Placeholder values
such as `TODO`, `none`, `later`, `...`, `-`, or bracketed placeholders are not
valid evidence.

The full current candidate tree validates this registry even when the command
reports a selected file set or a Git range. Filtered modes change the report,
not which registrations must remain current. The detector associates source
structure assertions with production-source values in the same bounded test
block; unrelated JSON, artifact, filesystem, or compatibility text is not a
candidate. The checker rejects duplicate, stale, or incomplete registrations,
while unregistered candidates remain advisory until they are reviewed
individually.

```test-structure-coupling-registry-v1
{
  "version": 1,
  "entries": []
}
```
