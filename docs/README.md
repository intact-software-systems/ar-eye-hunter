# Rallar Documentation

This directory contains user-facing and AI-facing documentation for the browser Rallar facade, Rallar browser data stores, and Rallar server middleware.

## Documents

- [Rallar API Reference](./rallar-api-reference.md)
  Complete public API description for `rallar.ts`, `rallar-data.ts`, and `RallarMiddleware.ts`, with usage examples.
- [Rallar AI Skill Guide](./rallar-ai-skill.md)
  A skill-style operating guide for AI agents implementing or reviewing Rallar usage.
- [Rallar AI Prompting Guide](./rallar-ai-prompting-guide.md)
  Prompt templates and constraints for asking an AI to use Rallar, Rallar Data, or Rallar Server.
- [Rallar Quickstart And Recipes](./rallar-quickstart-and-recipes.md)
  Short recipes for common application tasks.
- [Rallar Troubleshooting Checklist](./rallar-troubleshooting-checklist.md)
  Practical checks for auth, rooms, WS, RTC, data stores, server middleware, and tests.

## Source Files

- Browser facade: `packages/shared-web/browser/rallar.ts`
- Browser data facade: `packages/shared-web/browser/rallar-data.ts`
- Server middleware: `packages/shared-server/rallar-system/middleware/RallarMiddleware.ts`
- Server facade wrappers: `packages/shared-server/rallar-facade/RallarServer.ts` and `packages/shared-server/rallar-facade/RallarServerApplication.ts`
