# Production Legacy Exception Registry

This registry records rare production compatibility boundaries that an authorized maintainer has
chosen to retain. Ordinary pull-request work does not edit this file when legacy is removed,
resolved, or minimized.

A retained entry describes only the code and its maintenance policy. It does not copy pull-request
numbers, reviews, plan identifiers, candidate identifiers, commits, digests, or approval receipts.
The merge authority and review history remain in GitHub.

## Retained exceptions

When retention is necessary, add one section headed `path#symbol` with these maintenance facts:

- Path
- Symbol
- Purpose
- Canonical owner
- Consumer dependency
- Why removal is unsafe
- Minimization
- Compatibility tests
- Named owner
- Review or removal condition
