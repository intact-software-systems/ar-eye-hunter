# Repo Code-Style Exception Registry

This registry records approved persistent exceptions to the authoritative
[repo TypeScript coding standard](../.agents/skills/rallar-code-writing/references/repo-code-style.md).
It starts empty. Do not register all existing legacy files above the size
thresholds retroactively.

Add an entry only when a TypeScript file above 800 physical lines or a function
above 60 physical lines is materially touched and remains above its threshold.
Materially touched means behavior, contracts, control flow, state, lifecycle,
structure, or responsibility changed. Import-only, formatting-only, typo, and
path-only changes do not trigger registration.

An exception records a deliberate human decision that keeping cohesive code
together is easier to understand than the available separation. It does not
suppress checker warnings, waive future review, or justify pass-through files
and helper chains. Keep size justifications here rather than in source comments.

## Required entry fields

Each entry records:

- Repository-relative path;
- Symbol, when the exception applies to a function, method, constructor,
  accessor, or callback;
- Exception category;
- Why cohesion is clearer than the available separation;
- Approval date and reviewer;
- Review or removal condition.

Use one of the accepted categories from the canonical standard: declarative
schema or protocol definition, static lookup data, structured test scenario,
parser or state-transition table, approved export-only package barrel, or
cohesive algorithm.

## Approved exceptions

No approved exceptions are recorded.
