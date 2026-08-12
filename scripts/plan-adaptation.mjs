#!/usr/bin/env node

import {
  applyAdaptivePlan,
  checkAdaptivePlans,
  closeAdaptivePlan,
  completeAdaptivePlanSlice,
  initAdaptivePlan,
  prepareAdaptivePlan,
} from './plan-adaptation/plan-adaptation-lifecycle.mjs';
import { readActivePlans } from './plan-adaptation/active-plan-registry.mjs';

try {
  const input = readCommand(process.argv.slice(2));
  runCommand(input);
} catch (error) {
  console.log(`FAIL: ${toError(error).message}`);
  process.exitCode = 1;
}

function runCommand(input) {
  if (input.command === 'init') {
    initAdaptivePlan(input);
  } else if (input.command === 'complete-slice') {
    completeAdaptivePlanSlice(input);
  } else if (input.command === 'prepare') {
    const draftPath = prepareAdaptivePlan(input);
    console.log(`PASS: prepared ${draftPath}`);
    return;
  } else if (input.command === 'apply') {
    applyAdaptivePlan(input);
  } else if (input.command === 'check') {
    checkAdaptivePlans(input);
  } else if (input.command === 'close') {
    closeAdaptivePlan(input);
  }
  console.log(`PASS: plan adaptation ${input.command}`);
}

function readCommand(args) {
  const command = args[0];
  const commands = new Set(['init', 'complete-slice', 'prepare', 'apply', 'check', 'close']);
  if (!commands.has(command)) {
    throw new Error('expected command init, complete-slice, prepare, apply, check, or close');
  }
  const options = readOptions(args.slice(1));
  const activePlan = readSingleActivePlan();
  const base =
    options.base ??
    process.env.PLAN_ADAPTATION_BASE ??
    activePlan?.record.facts?.diffBase ??
    'origin/main';
  const planPath = options.plan ?? process.env.PLAN_ADAPTATION_PLAN ?? activePlan?.planPath;
  if (command !== 'check' && !planPath) {
    throw new Error('no single active adaptive plan was found; supply --plan');
  }
  if (command === 'complete-slice' && !options.slice) {
    throw new Error('complete-slice requires --slice');
  }
  if (command === 'close' && !options['final-pr-evidence']) {
    throw new Error('close requires --final-pr-evidence');
  }
  return {
    command,
    repoRoot: process.cwd(),
    planPath,
    base,
    slice: options.slice,
    finalPrEvidence: options['final-pr-evidence'],
  };
}

function readSingleActivePlan() {
  const activePlans = readActivePlans(process.cwd());
  if (activePlans.length === 1) {
    return activePlans[0];
  }
  return undefined;
}

function readOptions(args) {
  const options = {};
  for (let index = 0; index < args.length; index += 2) {
    const option = args[index];
    const value = args[index + 1];
    if (!option?.startsWith('--') || value === undefined) {
      throw new Error('expected --name value options');
    }
    const name = option.slice(2);
    if (options[name] !== undefined) {
      throw new Error(`option --${name} was supplied more than once`);
    }
    options[name] = value;
  }
  return options;
}

function toError(value) {
  return value instanceof Error ? value : new Error(String(value));
}
