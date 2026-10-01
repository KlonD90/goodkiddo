import fs from 'fs';
import path from 'path';

import { reloadEnvFile } from '../../src/config/env.js';
import { isValidGroupFolder } from '../../src/groups/group-folder.js';
import { emitStatus } from '../cli/status.js';
import { BunPromptUi, canPromptInteractively, type PromptUi } from '../cli/prompt-ui.js';
import { SetupStepError } from '../cli/setup-error.js';
import {
  buildSetupWizardStatusLines,
  type CredentialKind,
  loadSetupWizardState,
  type SetupChannelKind,
  type SetupWizardState,
} from '../state/setup-wizard-state.js';

const ENV_FILE = path.join(process.cwd(), '.env');

interface WizardPrefill {
  assistantName?: string;
  channel?: SetupChannelKind;
  discordToken?: string;
  telegramToken?: string;
  claudeCodeOauthToken?: string;
  anthropicApiKey?: string;
  jid?: string;
  name?: string;
  folder?: string;
  isMain?: boolean;
  requiresTrigger?: boolean;
}

interface WizardDeps {
  ui: PromptUi;
  loadState: () => SetupWizardState;
  writeEnvUpdates: (updates: Record<string, string>) => void;
  reloadEnv: () => void;
  registerRoom: (args: string[]) => Promise<void>;
  runRunners: () => Promise<void>;
  runService: () => Promise<void>;
  runVerify: () => Promise<void>;
}

function slugifyFolderName(value: string): string {
  const normalized = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
  return normalized || 'main';
}

function updateEnvContent(
  original: string,
  updates: Record<string, string>,
): string {
  let content = original;
  for (const [key, value] of Object.entries(updates)) {
    const line = `${key}=${JSON.stringify(value)}`;
    if (new RegExp(`^${key}=`, 'm').test(content)) {
      content = content.replace(new RegExp(`^${key}=.*$`, 'm'), line);
      continue;
    }
    if (content && !content.endsWith('\n')) {
      content += '\n';
    }
    content += `${line}\n`;
  }
  return content;
}

function readExistingEnvContent(): string {
  try {
    return fs.readFileSync(ENV_FILE, 'utf-8');
  } catch {
    return '';
  }
}

function writeEnvUpdates(updates: Record<string, string>): void {
  const next = updateEnvContent(readExistingEnvContent(), updates);
  fs.writeFileSync(ENV_FILE, next);
}

function parseWizardPrefillArgs(args: string[]): WizardPrefill {
  const prefill: WizardPrefill = {};

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    const value = args[i + 1] || '';

    switch (arg) {
      case '--assistant-name':
        prefill.assistantName = value;
        i++;
        break;
      case '--channel':
        if (value === 'discord' || value === 'telegram') {
          prefill.channel = value;
        }
        i++;
        break;
      case '--discord-token':
        prefill.discordToken = value;
        i++;
        break;
      case '--telegram-token':
        prefill.telegramToken = value;
        i++;
        break;
      case '--claude-code-oauth-token':
        prefill.claudeCodeOauthToken = value;
        i++;
        break;
      case '--anthropic-api-key':
        prefill.anthropicApiKey = value;
        i++;
        break;
      case '--jid':
        prefill.jid = value;
        i++;
        break;
      case '--name':
        prefill.name = value;
        i++;
        break;
      case '--folder':
        prefill.folder = value;
        i++;
        break;
      case '--is-main':
        prefill.isMain = true;
        break;
      case '--no-trigger-required':
        prefill.requiresTrigger = false;
        break;
    }
  }

  return prefill;
}

function resolveChosenChannel(
  prefill: WizardPrefill,
  state: SetupWizardState,
): SetupChannelKind | null {
  if (prefill.channel) {
    return prefill.channel;
  }
  if (prefill.jid?.startsWith('dc:')) {
    return 'discord';
  }
  if (prefill.jid?.startsWith('tg:')) {
    return 'telegram';
  }
  if (state.needsChannel) {
    return null;
  }
  if (state.needsRegistration && state.configuredChannels.length === 1) {
    return state.configuredChannels[0];
  }
  return null;
}

function normalizePlatformId(
  channel: SetupChannelKind,
  rawValue: string | undefined,
): string | null {
  const value = (rawValue || '').trim();
  if (!value) return null;

  const prefix = channel === 'discord' ? 'dc:' : 'tg:';
  const candidate = value.startsWith(prefix) ? value.slice(prefix.length) : value;
  return /^[0-9-]+$/.test(candidate) ? candidate : null;
}

function buildRoomDefaults(
  channel: SetupChannelKind,
  prefill: WizardPrefill,
): { name: string; folder: string } {
  const name =
    prefill.name ||
    (channel === 'discord' ? 'My Server #general' : 'Telegram chat');
  const folder = prefill.folder || `${channel}_${slugifyFolderName(name)}`;
  return { name, folder };
}

function buildCompletionMessage(state: SetupWizardState): string {
  const lines = ['Setup wizard complete.', '', 'Current status:'];
  lines.push(...buildSetupWizardStatusLines(state));
  lines.push('');

  const nextActions: string[] = [];
  if (state.needsCredentials) {
    nextActions.push('Add a Claude Code OAuth token or Anthropic API key.');
  }
  if (state.needsChannel) {
    nextActions.push('Configure at least one channel token.');
  }
  if (state.needsRegistration) {
    nextActions.push('Register at least one room.');
  }
  if (state.needsServiceSetup) {
    nextActions.push('Run service setup or verification when you are ready.');
  }

  if (nextActions.length === 0) {
    lines.push('Everything looks configured and ready.');
  } else {
    lines.push('Next actions:');
    for (const action of nextActions) {
      lines.push(`- ${action}`);
    }
  }

  return lines.join('\n');
}

async function promptForCredential(
  ui: PromptUi,
  kind: CredentialKind,
): Promise<string> {
  if (kind === 'claude-code-oauth-token') {
    return ui.password({
      message: 'Claude Code OAuth token',
      required: true,
      validate: (value) => (value.length >= 10 ? null : 'Token looks too short.'),
    });
  }

  return ui.password({
    message: 'Anthropic API key',
    required: true,
    validate: (value) =>
      value.length >= 10 ? null : 'API key looks too short.',
  });
}

async function ensureAssistantAndCredentials(
  prefill: WizardPrefill,
  state: SetupWizardState,
  ui: PromptUi,
): Promise<Record<string, string>> {
  const updates: Record<string, string> = {};
  const assistantName = prefill.assistantName || state.env.assistantName || 'Codex';

  if (!state.env.assistantName && !prefill.assistantName) {
    updates.ASSISTANT_NAME = await ui.text({
      message: 'Assistant name',
      defaultValue: assistantName,
      required: true,
    });
  } else if (prefill.assistantName && prefill.assistantName !== state.env.assistantName) {
    updates.ASSISTANT_NAME = prefill.assistantName;
  } else if (!state.env.assistantName) {
    updates.ASSISTANT_NAME = assistantName;
  }

  if (prefill.claudeCodeOauthToken) {
    updates.CLAUDE_CODE_OAUTH_TOKEN = prefill.claudeCodeOauthToken;
  } else if (prefill.anthropicApiKey) {
    updates.ANTHROPIC_API_KEY = prefill.anthropicApiKey;
  } else if (state.needsCredentials) {
    const chosenKind =
      state.credentialKind ||
      (await ui.select<CredentialKind>({
        message: 'How do you want to authenticate GoodKiddo?',
        initialValue: 'claude-code-oauth-token',
        options: [
          {
            label: 'Claude Code OAuth token',
            value: 'claude-code-oauth-token',
            hint: 'Recommended for normal GoodKiddo installs',
          },
          {
            label: 'Anthropic API key',
            value: 'anthropic-api-key',
            hint: 'Use if you prefer API key auth',
          },
        ],
      }));
    const credential = await promptForCredential(ui, chosenKind);
    if (chosenKind === 'claude-code-oauth-token') {
      updates.CLAUDE_CODE_OAUTH_TOKEN = credential;
    } else {
      updates.ANTHROPIC_API_KEY = credential;
    }
  }

  return updates;
}

async function ensureChannelToken(
  channel: SetupChannelKind,
  prefill: WizardPrefill,
  state: SetupWizardState,
  ui: PromptUi,
): Promise<Record<string, string>> {
  const updates: Record<string, string> = {};
  const tokenEnvKey =
    channel === 'discord' ? 'DISCORD_BOT_TOKEN' : 'TELEGRAM_BOT_TOKEN';
  const prefilledToken =
    channel === 'discord' ? prefill.discordToken : prefill.telegramToken;
  const existingToken =
    channel === 'discord' ? state.env.discordToken : state.env.telegramToken;

  if (prefilledToken) {
    updates[tokenEnvKey] = prefilledToken;
    return updates;
  }

  if (existingToken) {
    return updates;
  }

  updates[tokenEnvKey] = await ui.password({
    message: `${channel === 'discord' ? 'Discord' : 'Telegram'} bot token`,
    required: true,
    validate: (value) => (value.length >= 10 ? null : 'Token looks too short.'),
  });

  return updates;
}

async function chooseChannel(
  prefill: WizardPrefill,
  state: SetupWizardState,
  ui: PromptUi,
): Promise<SetupChannelKind> {
  const chosen = resolveChosenChannel(prefill, state);
  if (chosen) {
    return chosen;
  }

  const options =
    state.configuredChannels.length > 0
      ? state.configuredChannels
      : (['discord', 'telegram'] as SetupChannelKind[]);

  return ui.select<SetupChannelKind>({
    message:
      state.needsChannel || options.length === 0
        ? 'Which channel do you want to configure?'
        : 'Which configured channel should the first room use?',
    initialValue: options.includes('discord') ? 'discord' : options[0],
    options: options.map((channel) => ({
      label: channel === 'discord' ? 'Discord' : 'Telegram',
      value: channel,
      hint:
        channel === 'discord'
          ? 'Primary bot token'
          : 'Single-bot adapter',
    })),
  });
}

async function registerFirstRoom(args: {
  channel: SetupChannelKind;
  assistantName: string;
  prefill: WizardPrefill;
  ui: PromptUi;
  registerRoom: (args: string[]) => Promise<void>;
}): Promise<{
  jid: string;
  folder: string;
}> {
  const { name: defaultName, folder: defaultFolder } = buildRoomDefaults(
    args.channel,
    args.prefill,
  );
  const rawId =
    normalizePlatformId(args.channel, args.prefill.jid) ||
    (await args.ui.text({
      message:
        args.channel === 'discord'
          ? 'Discord channel ID (numbers only)'
          : 'Telegram chat ID (numbers only)',
      required: true,
      validate: (value) =>
        normalizePlatformId(args.channel, value)
          ? null
          : 'Use only the numeric platform ID.',
    }));

  const roomName =
    args.prefill.name ||
    (await args.ui.text({
      message: 'Room display name',
      defaultValue: defaultName,
      required: true,
    }));

  const folder =
    args.prefill.folder ||
    (await args.ui.text({
      message: 'Group folder name',
      defaultValue: defaultFolder,
      required: true,
      validate: (value) =>
        isValidGroupFolder(value)
          ? null
          : 'Use letters, numbers, underscores, or dashes only.',
    }));

  const isMain =
    args.prefill.isMain ??
    (await args.ui.confirm({
      message: 'Should this be the main control room?',
      initialValue: true,
    }));
  const requiresTrigger = isMain
    ? false
    : (args.prefill.requiresTrigger ??
      (await args.ui.confirm({
        message: `Require @${args.assistantName} before replying?`,
        initialValue: true,
      })));

  const jidPrefix = args.channel === 'discord' ? 'dc:' : 'tg:';
  const jid = `${jidPrefix}${normalizePlatformId(args.channel, rawId) || rawId}`;

  await args.registerRoom([
    '--channel',
    args.channel,
    '--jid',
    jid,
    '--name',
    roomName,
    '--folder',
    folder,
    '--trigger',
    `@${args.assistantName}`,
    '--assistant-name',
    args.assistantName,
    ...(isMain ? ['--is-main'] : []),
    ...(!requiresTrigger ? ['--no-trigger-required'] : []),
  ]);

  return { jid, folder };
}

async function runWizardFlow(
  prefill: WizardPrefill,
  deps: WizardDeps,
): Promise<void> {
  let state = deps.loadState();

  deps.ui.intro('GoodKiddo setup wizard');
  deps.ui.note('Current status', buildSetupWizardStatusLines(state).join('\n'));

  const envUpdates = await ensureAssistantAndCredentials(
    prefill,
    state,
    deps.ui,
  );

  const needsRoomWork =
    state.needsRegistration ||
    Boolean(prefill.jid || prefill.name || prefill.folder);
  const needsChannelWork =
    state.needsChannel ||
    Boolean(
      prefill.channel ||
        prefill.discordToken ||
        prefill.telegramToken ||
        prefill.jid ||
        needsRoomWork,
    );

  let selectedChannel: SetupChannelKind | null = null;
  if (needsChannelWork) {
    selectedChannel = await chooseChannel(prefill, state, deps.ui);
    Object.assign(
      envUpdates,
      await ensureChannelToken(selectedChannel, prefill, state, deps.ui),
    );
  }

  if (Object.keys(envUpdates).length > 0) {
    deps.writeEnvUpdates(envUpdates);
    deps.reloadEnv();
    deps.ui.note(
      'Saved environment',
      Object.keys(envUpdates)
        .map((key) => `- Updated ${key}`)
        .join('\n'),
    );
    state = deps.loadState();
  }

  let room: { jid: string; folder: string } | null = null;
  if (needsRoomWork) {
    const shouldRegister =
      prefill.jid ||
      (await deps.ui.confirm({
        message: 'Do you want to register the first room now?',
        initialValue: true,
      }));
    if (shouldRegister) {
      room = await registerFirstRoom({
        channel: selectedChannel || (await chooseChannel(prefill, state, deps.ui)),
        assistantName: state.env.assistantName || envUpdates.ASSISTANT_NAME || 'Codex',
        prefill,
        ui: deps.ui,
        registerRoom: deps.registerRoom,
      });
      deps.ui.note(
        'Registered room',
        `- ${room.jid} -> ${room.folder}`,
      );
      state = deps.loadState();
    }
  }

  let verifyAttempted = false;
  if (state.needsServiceSetup) {
    const shouldSetupServices = await deps.ui.confirm({
      message: 'Build runners and install/start services now?',
      initialValue: true,
    });
    if (shouldSetupServices) {
      deps.ui.note(
        'Service setup',
        'Building runners, installing services, and then verifying the stack.',
      );
      try {
        await deps.runRunners();
        await deps.runService();
        await deps.runVerify();
        verifyAttempted = true;
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        deps.ui.note(
          'Service setup needs attention',
          `- ${message}\n- You can re-run \`bun run setup\` later to resume.`,
        );
      }
      state = deps.loadState();
    }
  } else {
    verifyAttempted = await deps.ui.confirm({
      message: 'Everything looks configured. Run verification now?',
      initialValue: true,
    });
    if (verifyAttempted) {
      try {
        await deps.runVerify();
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        deps.ui.note('Verification needs attention', `- ${message}`);
      }
      state = deps.loadState();
    }
  }

  const finalMessage = buildCompletionMessage(state);
  deps.ui.outro(finalMessage);

  emitStatus('WIZARD', {
    STATUS:
      state.needsCredentials || state.needsChannel || state.needsRegistration
        ? 'partial'
        : 'success',
    CHANNEL: selectedChannel || 'unchanged',
    REGISTERED_ROOM: room?.jid || 'none',
    VERIFY_RAN: verifyAttempted,
    LOG: 'logs/setup.log',
  });
}

function createDefaultDeps(): WizardDeps {
  return {
    ui: new BunPromptUi(),
    loadState: () => loadSetupWizardState(),
    writeEnvUpdates,
    reloadEnv: () => reloadEnvFile(),
    registerRoom: async (args) => {
      const mod = await import('./register.js');
      await mod.run(args);
    },
    runRunners: async () => {
      const mod = await import('./runners.js');
      await mod.run([]);
    },
    runService: async () => {
      const mod = await import('./service.js');
      await mod.run([]);
    },
    runVerify: async () => {
      const mod = await import('./verify.js');
      await mod.run([]);
    },
  };
}

export async function run(args: string[]): Promise<void> {
  if (!canPromptInteractively()) {
    emitStatus('WIZARD', {
      STATUS: 'failed',
      ERROR: 'interactive_terminal_required',
      LOG: 'logs/setup.log',
    });
    throw new SetupStepError(
      'The setup wizard requires an interactive terminal. Re-run it in a local shell.',
    );
  }

  await runWizardFlow(parseWizardPrefillArgs(args), createDefaultDeps());
}

export const _testing = {
  buildCompletionMessage,
  parseWizardPrefillArgs,
  runWizardFlow,
  slugifyFolderName,
  updateEnvContent,
};
