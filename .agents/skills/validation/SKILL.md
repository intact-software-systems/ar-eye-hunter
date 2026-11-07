---
name: validation
description: Writes the session command catalog from the AI Handoff Contract. Use when a command failed, was skipped, or changed a decision, or when someone asks for the validation section or /validation.
user-invocable: true
---

# Validation

Read the AI Handoff Contract in `AGENTS.md` and write its `### Validation` section from this session.

Use the commands and consequential tool actions still present in the transcript. Do not invent a command or a result. After the transcript is compacted, report only what it still contains.
