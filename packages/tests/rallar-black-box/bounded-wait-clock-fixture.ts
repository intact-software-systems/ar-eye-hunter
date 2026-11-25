import type * as Playwright from '@playwright/test';
import { AsyncLocalStorage } from 'node:async_hooks';
import { vi } from 'vitest';

/** The most fake timer turns a measured harness run may take before it is taken to hang. */
const MEASURED_RUN_TURN_LIMIT = 10_000;

const polling = new AsyncLocalStorage<true>();

const COUNTED_LOCATOR = Symbol('counted locator');

/**
 * Spends one bounded wait on the fake clock. A wait inside a counted poll spends nothing: the poll counts by its own
 * limit.
 */
export async function spendBoundedWait(waitMs: number): Promise<void> {
    if (polling.getStore()) {
        return;
    }
    await new Promise((resolve) => setTimeout(resolve, waitMs));
}

/** Reads a poll's value once, then spends the poll's whole limit, as the timeouts count a poll. */
async function pollBoundedWait<T>(read: () => Promise<T> | T, timeoutMs: number): Promise<T> {
    const value = await polling.run(true, async () => await read());
    await spendBoundedWait(timeoutMs);
    return value;
}

/** Runs a harness operation to its end under fake timers, advancing the fake clock through every wait it spends. */
export async function settleUnderFakeTimers<T>(run: () => Promise<T>): Promise<T> {
    let settled = false;
    const pending = run().finally(() => {
        settled = true;
    });
    for (let turn = 0; !settled; turn++) {
        if (turn === MEASURED_RUN_TURN_LIMIT) {
            throw new Error('The measured harness run did not settle.');
        }
        await vi.runAllTimersAsync();
    }
    return await pending;
}

/**
 * Runs a harness operation under fake timers whose every bounded wait spends its bound, and returns the fake time it
 * took: the sum of its bounded waits in order, waits side by side counting by the longest.
 */
export async function measureBoundedWaitsMs(run: () => Promise<unknown>): Promise<number> {
    const startedAtMs = performance.now();
    await settleUnderFakeTimers(run);
    return performance.now() - startedAtMs;
}

/** Whether a value is a locator of a counted page. */
function isCountedLocator(value: unknown): boolean {
    return typeof value === 'object' && value !== null && COUNTED_LOCATOR in value;
}

/** The options argument a Playwright matcher or poll was given last, if any. */
function readTimeoutOption(args: readonly unknown[]): number | undefined {
    const options = args.at(-1);
    return typeof options === 'object' && options !== null && 'timeout' in options &&
            typeof options.timeout === 'number'
        ? options.timeout
        : undefined;
}

/** Every matcher of a counted locator spends its named limit, or the configuration's default assertion limit. */
function toCountedLocatorMatchers(expectTimeoutMs: number): object {
    const matchers: object = new Proxy({}, {
        get: (_target, property) =>
            property === 'not'
                ? matchers
                : async (...args: readonly unknown[]) => {
                    await spendBoundedWait(readTimeoutOption(args) ?? expectTimeoutMs);
                }
    });
    return matchers;
}

/** Every matcher of a counted poll reads the value once, spends the poll's limit, then asserts as Playwright does. */
function toCountedPollMatchers(
    actual: Playwright.Expect,
    read: () => unknown,
    options: unknown,
    expectTimeoutMs: number
): object {
    return new Proxy({}, {
        get: (_target, matcher: string) => async (...expected: readonly unknown[]) => {
            const value = await pollBoundedWait(read, readTimeoutOption([options]) ?? expectTimeoutMs);
            (actual(value) as unknown as Record<string, (...args: readonly unknown[]) => void>)[matcher](...expected);
        }
    });
}

/**
 * The `@playwright/test` module with an `expect` whose polls and counted locators' assertions spend their limits on the
 * fake clock; every other assertion runs as Playwright's own.
 */
export function toCountedPlaywrightModule(
    actualModule: typeof Playwright,
    expectTimeoutMs: number
): typeof Playwright {
    const actual = actualModule.expect;
    const counted = (value: unknown, message?: string) => isCountedLocator(value) ? toCountedLocatorMatchers(expectTimeoutMs) : actual(value, message);
    const expect = new Proxy(counted, {
        get: (_target, property) =>
            property === 'poll'
                ? (read: () => unknown, options?: unknown) => toCountedPollMatchers(actual, read, options, expectTimeoutMs)
                : Reflect.get(actual, property)
    });
    return { ...actualModule, expect: expect as unknown as Playwright.Expect };
}

/** A locator whose every query returns a locator and whose every action does nothing. */
function createCountedLocator(): object {
    const locator: object = new Proxy({ [COUNTED_LOCATOR]: true }, {
        get: (target, property) => property === COUNTED_LOCATOR ? true : property === 'then' ? undefined : () => locator
    });
    return locator;
}

/**
 * A page whose locators are counted, whose `waitForTimeout` spends its delay and whose evaluations answer through
 * `evaluate`; every other call does nothing.
 */
export function createCountedPage(evaluate: (...args: readonly unknown[]) => unknown = () => undefined): Playwright.Page {
    const page: object = new Proxy({}, {
        get: (_target, property) => {
            if (property === 'then') {
                return undefined;
            }
            if (property === 'waitForTimeout') {
                return spendBoundedWait;
            }
            if (property === 'evaluate') {
                return async (...args: readonly unknown[]) => await evaluate(...args);
            }
            return () => createCountedLocator();
        }
    });
    return page as Playwright.Page;
}
