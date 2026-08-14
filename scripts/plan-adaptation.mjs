#!/usr/bin/env node

import {
  applyAdaptivePlan,
  checkAdaptivePlans,
  closeAdaptivePlan,
  completeAdaptivePlanSlice,
  initAdaptivePlan,
  postponeAdaptivePlan,
  prepareAdaptivePlan,
  resumeAdaptivePlan,
} from './plan-adaptation/plan-adaptation-lifecycle.mjs';
import {
  readAdaptivePlanCatalog,
  writeAdaptivePlanOverview,
} from './plan-adaptation/adaptive-plan-catalog.mjs';

const commandHandlers = {
  apply: applyAdaptivePlan,
  check: checkAdaptivePlans,
  close: closeAdaptivePlan,
  'complete-slice': completeAdaptivePlanSlice,
  init: initAdaptivePlan,
  overview: ({ repoRoot }) => writeAdaptivePlanOverview(repoRoot),
  postpone: postponeAdaptivePlan,
  prepare: prepareAdaptivePlan,
  resume: resumeAdaptivePlan,
};

try {
  const input = readCommand(process.argv.slice(2));
  runCommand(input);
} catch (error) {
  console.log(`FAIL: ${toError(error).message}`);
  process.exitCode = 1;
}

function runCommand(input) {
  const result = commandHandlers[input.command](input);
  console.log(
    input.command === 'prepare'
      ? `PASS: prepared ${result}`
      : `PASS: plan adaptation ${input.command}`,
  );
}

function readCommand(args) {
  const command = args[0];
  if (!Object.hasOwn(commandHandlers, command)) {
    throw new Error(
      'expected command init, complete-slice, prepare, apply, check, close, overview, ' +
        'postpone, or resume',
    );
  }
  const options = readOptions(args.slice(1), allowedOptions(command));
  const selectedPlan = readSelectedPlan(command, options.plan);
  const base =
    options.base ??
    process.env.PLAN_ADAPTATION_BASE ??
    selectedPlan?.record.facts?.diffBase ??
    'origin/main';
  const planPath = options.plan ?? process.env.PLAN_ADAPTATION_PLAN ?? selectedPlan?.planPath;
  if (!['check', 'overview'].includes(command) && !planPath)
    throw new Error('no single eligible adaptive plan was found; supply --plan');
  if (command === 'complete-slice' && !options.slice)
    throw new Error('complete-slice requires --slice');
  if (command === 'close' && !options['final-pr-evidence'])
    throw new Error('close requires --final-pr-evidence');
  if (['postpone', 'resume'].includes(command) && !options.reason?.trim())
    throw new Error(`${command} requires --reason`);
  return {
    command,
    repoRoot: process.cwd(),
    planPath,
    base,
    slice: options.slice,
    finalPrEvidence: options['final-pr-evidence'],
    reason: options.reason,
  };
}

function readSelectedPlan(command, explicitPlanPath) {
  if (command === 'overview' || explicitPlanPath !== undefined) return undefined;
  const catalog = readAdaptivePlanCatalog(process.cwd());
  const collection = { close: 'plans', resume: 'postponedPlans' }[command] ?? 'activePlans';
  const eligible = catalog[collection];
  return eligible.length === 1 ? eligible[0] : undefined;
}

function allowedOptions(command) {
  const allowed = new Set(['base', 'plan']);
  if (command === 'complete-slice') allowed.add('slice');
  if (command === 'close') allowed.add('final-pr-evidence');
  if (command === 'postpone' || command === 'resume') allowed.add('reason');
  if (command === 'overview') return new Set();
  return allowed;
}

function readOptions(args, allowed) {
  const options = {};
  for (let index = 0; index < args.length; index += 2) {
    const option = args[index];
    const value = args[index + 1];
    if (!option?.startsWith('--') || value === undefined) {
      throw new Error('expected --name value options');
    }
    const name = option.slice(2);
    if (!allowed.has(name)) {
      throw new Error(`unknown option --${name}`);
    }
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
