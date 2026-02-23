import { Temporal } from "@js-temporal/polyfill";
(globalThis as any).Temporal = (globalThis as any).Temporal ?? Temporal;