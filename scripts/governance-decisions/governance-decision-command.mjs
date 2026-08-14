const commandOptions = {
  preview: ['--request', '--repo'],
  apply: ['--request', '--repo'],
  'publish-request': ['--request', '--repo'],
  'verify-commit': ['--commit', '--repo'],
};

export function decodeGovernanceDecisionCommand(arguments_) {
  const [command, ...optionTokens] = arguments_;
  if (!Object.hasOwn(commandOptions, command)) {
    throw new Error('command must be preview, apply, publish-request, or verify-commit');
  }
  const values = readOptions(optionTokens, commandOptions[command]);
  const repoRoot = values['--repo'] ?? process.cwd();
  if (command === 'preview' || command === 'apply' || command === 'publish-request') {
    requireOption(values, '--request', command);
    return { command, requestPath: values['--request'], repoRoot };
  }
  requireOption(values, '--commit', command);
  requireObjectId(values['--commit'], '--commit');
  return {
    command,
    commitOid: values['--commit'],
    repoRoot,
  };
}

function readOptions(optionTokens, allowedOptions) {
  const values = {};
  for (let index = 0; index < optionTokens.length; index += 2) {
    const option = optionTokens[index];
    const value = optionTokens[index + 1];
    if (!allowedOptions.includes(option)) {
      throw new Error(`unsupported option: ${option}`);
    }
    if (typeof value !== 'string' || value === '' || value.startsWith('--')) {
      throw new Error(`${option} requires one value`);
    }
    if (Object.hasOwn(values, option)) {
      throw new Error(`${option} must be provided exactly once`);
    }
    values[option] = value;
  }
  return values;
}

function requireOption(values, option, command) {
  if (!Object.hasOwn(values, option)) {
    throw new Error(`${command} requires ${option}`);
  }
}

function requireObjectId(value, option) {
  if (!/^[0-9a-f]{40}$/u.test(value)) {
    throw new Error(`${option} must be a full lowercase Git object ID`);
  }
}
