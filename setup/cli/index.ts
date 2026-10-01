/**
 * Setup CLI entry point.
 * Usage: bun setup/cli/index.ts [wizard-prefill args]
 *        bun setup/cli/index.ts --step <name> [args...]
 */
import { logger } from '../../src/config/logger.js';
import { buildSetupWizardStatusLines, loadSetupWizardState } from '../state/setup-wizard-state.js';
import { canPromptInteractively } from './prompt-ui.js';
import { emitStatus } from './status.js';
import { SetupStepError } from './setup-error.js';

const STEPS: Record<
  string,
  () => Promise<{ run: (args: string[]) => Promise<void> }>
> = {
  environment: () => import('../steps/environment.js'),
  runners: () => import('../steps/runners.js'),
  groups: () => import('../steps/groups.js'),
  register: () => import('../steps/register.js'),
  'restart-stack': () => import('../steps/restart-stack.js'),
  service: () => import('../steps/service.js'),
  uninstall: () => import('../steps/uninstall.js'),
  verify: () => import('../steps/verify.js'),
  wizard: () => import('../steps/wizard.js'),
};

const WIZARD_BOOLEAN_FLAGS = new Set(['--is-main', '--no-trigger-required']);
const WIZARD_VALUE_FLAGS = new Set([
  '--assistant-name',
  '--channel',
  '--discord-token',
  '--telegram-token',
  '--claude-code-oauth-token',
  '--anthropic-api-key',
  '--jid',
  '--name',
  '--folder',
]);

type SetupInvocation =
  | { kind: 'help' }
  | { kind: 'error'; message: string; exitCode: number }
  | { kind: 'step'; stepName: string; stepArgs: string[] }
  | { kind: 'wizard'; wizardArgs: string[] };

function buildUsageText(): string {
  return [
    'GoodKiddo setup',
    '',
    'Default:',
    '  bun run setup',
    '',
    'Wizard prefill examples:',
    '  bun run setup -- --channel discord --assistant-name Codex',
    '  bun run setup -- --channel telegram --jid tg:123456 --name "Ops Chat"',
    '',
    'Advanced/internal steps:',
    `  bun run setup -- --step <${Object.keys(STEPS).join('|')}> [args...]`,
  ].join('\n');
}

function validateWizardArgs(args: string[]): SetupInvocation {
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--') {
      continue;
    }
    if (WIZARD_BOOLEAN_FLAGS.has(arg)) {
      continue;
    }
    if (WIZARD_VALUE_FLAGS.has(arg)) {
      if (!args[i + 1] || args[i + 1].startsWith('--')) {
        return {
          kind: 'error',
          message: `Missing value for ${arg}`,
          exitCode: 1,
        };
      }
      i++;
      continue;
    }
    if (arg.startsWith('--')) {
      return {
        kind: 'error',
        message: `Unknown setup argument: ${arg}`,
        exitCode: 1,
      };
    }
    return {
      kind: 'error',
      message: `Unexpected positional argument: ${arg}`,
      exitCode: 1,
    };
  }

  return {
    kind: 'wizard',
    wizardArgs: args.filter((arg) => arg !== '--'),
  };
}

function resolveSetupInvocation(args: string[]): SetupInvocation {
  if (args.includes('--help') || args.includes('-h')) {
    return { kind: 'help' };
  }

  const stepIdx = args.indexOf('--step');
  if (stepIdx !== -1) {
    const stepName = args[stepIdx + 1];
    if (!stepName) {
      return {
        kind: 'error',
        message: 'Missing value for --step',
        exitCode: 1,
      };
    }
    return {
      kind: 'step',
      stepName,
      stepArgs: args.filter(
        (arg, index) => index !== stepIdx && index !== stepIdx + 1 && arg !== '--',
      ),
    };
  }

  return validateWizardArgs(args);
}

function buildNonInteractiveWizardMessage(wizardArgs: string[]): string {
  const state = loadSetupWizardState();
  const lines = [
    'GoodKiddo setup needs an interactive terminal for the guided wizard.',
    '',
    'Current status:',
    ...buildSetupWizardStatusLines(state),
    '',
  ];

  if (wizardArgs.length > 0) {
    lines.push(
      'Re-run the same command in a local terminal to continue with these prefilled answers.',
    );
  } else {
    lines.push('Re-run `bun run setup` in a local terminal to continue.');
  }

  lines.push('');
  lines.push('You can still prefill common answers, for example:');
  lines.push(
    '  bun run setup -- --channel discord --assistant-name Codex --jid dc:1234567890',
  );
  lines.push('');
  lines.push(
    'Advanced manual steps remain available with `bun run setup -- --step <name>`.',
  );

  return lines.join('\n');
}

async function runSetupInvocation(invocation: SetupInvocation): Promise<void> {
  if (invocation.kind === 'help') {
    console.log(buildUsageText());
    return;
  }

  if (invocation.kind === 'error') {
    console.error(invocation.message);
    console.error('');
    console.error(buildUsageText());
    process.exit(invocation.exitCode);
  }

  if (invocation.kind === 'wizard' && !canPromptInteractively()) {
    console.log(buildNonInteractiveWizardMessage(invocation.wizardArgs));
    process.exit(1);
  }

  const stepName = invocation.kind === 'step' ? invocation.stepName : 'wizard';
  const stepArgs = invocation.kind === 'step' ? invocation.stepArgs : invocation.wizardArgs;
  const loader = STEPS[stepName];

  if (!loader) {
    console.error(`Unknown step: ${stepName}`);
    console.error(`Available steps: ${Object.keys(STEPS).join(', ')}`);
    process.exit(1);
  }

  try {
    const mod = await loader();
    await mod.run(stepArgs);
  } catch (err) {
    if (err instanceof SetupStepError) {
      process.exit(err.exitCode);
    }

    const message = err instanceof Error ? err.message : String(err);
    logger.error({ err, step: stepName }, 'Setup step failed');
    emitStatus(stepName.toUpperCase(), {
      STATUS: 'failed',
      ERROR: message,
    });
    process.exit(1);
  }
}

async function main(): Promise<void> {
  await runSetupInvocation(resolveSetupInvocation(process.argv.slice(2)));
}

if (import.meta.main) {
  void main();
}

export const _testing = {
  buildNonInteractiveWizardMessage,
  buildUsageText,
  resolveSetupInvocation,
};
