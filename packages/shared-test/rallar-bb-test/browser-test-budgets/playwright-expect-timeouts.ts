/** How long an assertion waits under the full-stack Playwright configuration when it names no limit of its own. */
export const FULL_STACK_EXPECT_TIMEOUT_MS = 15_000;

/** How long an assertion waits under the app's default Playwright configuration when it names no limit of its own. */
export const RALLAR_BLACK_BOX_EXPECT_TIMEOUT_MS = 10_000;

/** `openTab` waits for the tab's selection, then for its panel, each under the full-stack assertion limit. */
export const FULL_STACK_TAB_OPEN_BOUNDED_WAITS_MS = 2 * FULL_STACK_EXPECT_TIMEOUT_MS;
