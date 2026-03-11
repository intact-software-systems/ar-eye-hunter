import { Temporal } from '@js-temporal/polyfill';

(globalThis as { Temporal?: typeof Temporal }).Temporal ??= Temporal;
