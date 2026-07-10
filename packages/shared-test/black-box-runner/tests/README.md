# Black-box Runner Test Recipes

This directory contains executable recipes that are validation fixtures rather
than illustrative examples.

- `api-v1/` holds no-browser `apps/api-v1` REST/WS black-box scenarios run by
  the `api-v1-black-box` matrix profile and release-gate helper.

Use `api-v1-black-box` for full managed helper coverage. Add
`api-v1-black-box-recipes` only to scenarios that can run against an
already-running API without assuming server startup environment beyond the
published API/WS URLs and demo credentials.

Keep API-v1 recipes to HTTP, raw WS, SET, and ASSERT steps. They should not
require Playwright, browser providers, or RTC connections.
