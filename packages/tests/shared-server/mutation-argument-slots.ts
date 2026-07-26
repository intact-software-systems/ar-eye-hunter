export interface ArgumentSlot<Value> {
  readonly absent: boolean;
  readonly explicitUndefined: boolean;
  readonly unknown: boolean;
  readonly values: readonly Value[];
}

export function absentArgumentSlot<Value>(): ArgumentSlot<Value> {
  return {
    absent: true,
    explicitUndefined: false,
    unknown: false,
    values: [],
  };
}

export function undefinedArgumentSlot<Value>(): ArgumentSlot<Value> {
  return {
    absent: false,
    explicitUndefined: true,
    unknown: false,
    values: [],
  };
}

export function exactArgumentSlot<Value>(value: Value): ArgumentSlot<Value> {
  return {
    absent: false,
    explicitUndefined: false,
    unknown: false,
    values: [value],
  };
}

export function mergeArgumentSlots<Value>(
  slots: readonly ArgumentSlot<Value>[],
): ArgumentSlot<Value> {
  return {
    absent: slots.some((slot) => slot.absent),
    explicitUndefined: slots.some((slot) => slot.explicitUndefined),
    unknown: slots.some((slot) => slot.unknown),
    values: [...new Set(slots.flatMap((slot) => slot.values))],
  };
}

export function unknownArgumentSlot<Value>(
  values: readonly Value[] = [],
): ArgumentSlot<Value> {
  return {
    absent: false,
    explicitUndefined: false,
    unknown: true,
    values,
  };
}

export function argumentSlotUsesDefault<Value>(
  slot: ArgumentSlot<Value> | undefined,
): boolean {
  return !slot || slot.absent || slot.explicitUndefined;
}
