import { createRallarMatchResult } from './results.ts';
import type { RallarMatchResultInput } from './types.ts';

declare const input: RallarMatchResultInput<{ readonly reason: string; }>;
const result = createRallarMatchResult(input);
void result;
