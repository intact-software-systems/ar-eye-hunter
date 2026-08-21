# Playwright Suite Map

Playwright configs are app-owned. Run suites through the app config so the
right tests, dev server, ports, and browser options are selected.

| App                         | Tests                                                    | Config                                                  | Command                                                                   | Ports                                                      |
| --------------------------- | -------------------------------------------------------- | ------------------------------------------------------- | ------------------------------------------------------------------------- | ---------------------------------------------------------- |
| Rallar Black Box            | `tests/playwright/rallar-black-box`                      | `apps/rallar-black-box/playwright.config.ts`            | `npm run test:rallar`                                                     | SPA `5176`, control `5180`                                 |
| Rallar Black Box full stack | `tests/playwright/rallar-black-box/full-stack-*.spec.ts` | `apps/rallar-black-box/playwright.full-stack.config.ts` | `npm run test:rallar:full-stack`                                          | SPA from env/default, API from env/default, control `5180` |
| Rallar Black Box exhaustive | `tests/playwright/rallar-black-box/exhaustive-*.spec.ts` | `apps/rallar-black-box/playwright.exhaustive.config.ts` | `npm run test:rallar:exhaustive:postgres`                                 | SPA `5176`, API from env/default, control `5180`           |
| Relic Hunters               | `tests/playwright/relic-hunters`                         | `apps/relic-hunters-v1/playwright.config.ts`            | `npm run test:playwright:relic`                                           | SPA `5175`                                                 |
| Relic Hunters full stack    | `tests/playwright/relic-hunters/full-stack-*.spec.ts`    | `apps/relic-hunters-v1/playwright.full-stack.config.ts` | `npm run test:playwright:relic:full-stack`                                | SPA `5175`, API `8090`                                     |
| AR Eye Hunter               | `tests/playwright/ar-eye-hunter`                         | `apps/ar-eye-hunter-v1/playwright.config.ts`            | `npx playwright test --config apps/ar-eye-hunter-v1/playwright.config.ts` | SPA `5186`                                                 |

Avoid bare `npx playwright test` from the repository root. There is no root
config because a root default can silently start the wrong app for a test path.
