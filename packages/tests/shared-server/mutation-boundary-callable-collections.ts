import type { InvocationArgumentSlot } from './mutation-boundary-call-arguments.ts';
import type { CallableResolution } from './mutation-boundary-callable-resolution.ts';

export function callableArrayResolution(
  values: readonly CallableResolution[],
  unknown: boolean,
): CallableResolution {
  const members = new Map(values.map((value, index) => [String(index), value]));
  return {
    localProvenance: values.some((value) => value.localProvenance),
    members,
    targets: new Map(),
    unknown: unknown || values.some((value) => value.unknown),
  };
}

export function collectCallableTargets(
  resolution: CallableResolution,
): CallableResolution['targets'] {
  const targets = new Map(resolution.targets);
  for (const member of resolution.members.values()) {
    for (const [key, target] of collectCallableTargets(member)) {
      targets.set(key, target);
    }
  }
  return targets;
}

export function bindCallableResolution(
  resolution: CallableResolution,
  boundArguments: readonly InvocationArgumentSlot[],
  boundUnknown: boolean,
): CallableResolution {
  const targets = new Map(resolution.targets);
  for (const [key, target] of resolution.targets) {
    targets.set(key, {
      ...target,
      boundArguments: [...target.boundArguments, ...boundArguments],
      boundUnknown: target.boundUnknown || boundUnknown,
    });
  }
  return { ...resolution, targets };
}
