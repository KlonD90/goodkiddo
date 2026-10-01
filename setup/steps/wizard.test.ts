import { describe, expect, it, vi } from 'vitest';

import { _testing } from './wizard.js';
import type { PromptUi } from '../cli/prompt-ui.js';
import type { SetupWizardState } from '../state/setup-wizard-state.js';

describe('setup wizard helpers', () => {
  it('slugifies room names into safe folder names', () => {
    expect(_testing.slugifyFolderName('My Server #general')).toBe(
      'my_server_general',
    );
    expect(_testing.slugifyFolderName('  Telegram chat  ')).toBe(
      'telegram_chat',
    );
  });

  it('updates existing env keys in place', () => {
    const result = _testing.updateEnvContent(
      'ASSISTANT_NAME="Andy"\nDISCORD_BOT_TOKEN="old"\n',
      {
        ASSISTANT_NAME: 'Codex',
        DISCORD_BOT_TOKEN: 'new-token',
      },
    );

    expect(result).toContain('ASSISTANT_NAME="Codex"');
    expect(result).toContain('DISCORD_BOT_TOKEN="new-token"');
    expect(result).not.toContain('DISCORD_BOT_TOKEN="old"');
  });

  it('appends new env keys when they are missing', () => {
    const result = _testing.updateEnvContent('ASSISTANT_NAME="Codex"\n', {
      TELEGRAM_BOT_TOKEN: 'telegram-token',
    });

    expect(result).toContain('ASSISTANT_NAME="Codex"');
    expect(result).toContain('TELEGRAM_BOT_TOKEN="telegram-token"');
  });

  it('parses top-level wizard prefill flags', () => {
    expect(
      _testing.parseWizardPrefillArgs([
        '--assistant-name',
        'Codex',
        '--channel',
        'discord',
        '--jid',
        'dc:123',
        '--no-trigger-required',
      ]),
    ).toEqual({
      assistantName: 'Codex',
      channel: 'discord',
      jid: 'dc:123',
      requiresTrigger: false,
    });
  });
});

class FakePromptUi implements PromptUi {
  readonly notes: Array<{ title: string; body: string }> = [];
  introTitle = '';
  outroMessage = '';

  constructor(
    private readonly answers: {
      text?: string[];
      password?: string[];
      confirm?: boolean[];
      select?: string[];
    } = {},
  ) {}

  intro(title: string): void {
    this.introTitle = title;
  }

  note(title: string, body: string): void {
    this.notes.push({ title, body });
  }

  outro(message: string): void {
    this.outroMessage = message;
  }

  async text(): Promise<string> {
    return this.answers.text?.shift() || '';
  }

  async password(): Promise<string> {
    return this.answers.password?.shift() || '';
  }

  async confirm(): Promise<boolean> {
    return this.answers.confirm?.shift() ?? true;
  }

  async select<T extends string>(): Promise<T> {
    return (this.answers.select?.shift() || 'discord') as T;
  }
}

function createState(overrides: Partial<SetupWizardState> = {}): SetupWizardState {
  return {
    env: {
      assistantName: '',
      discordToken: '',
      telegramToken: '',
      claudeCodeOauthToken: '',
      anthropicApiKey: '',
    },
    credentialsConfigured: false,
    credentialKind: null,
    configuredChannels: [],
    registeredGroups: 0,
    groupsByAgent: {},
    serviceChecks: [{ name: 'goodkiddo', status: 'not_found' }],
    needsCredentials: true,
    needsChannel: true,
    needsRegistration: true,
    needsServiceSetup: true,
    ...overrides,
  };
}

describe('wizard flow', () => {
  it('resumes only missing setup and reuses prefilled answers', async () => {
    let state = createState({
      env: {
        assistantName: 'Codex',
        discordToken: 'discord-token',
        telegramToken: '',
        claudeCodeOauthToken: 'oauth-token',
        anthropicApiKey: '',
      },
      credentialsConfigured: true,
      credentialKind: 'claude-code-oauth-token',
      configuredChannels: ['discord'],
      needsCredentials: false,
      needsChannel: false,
      needsRegistration: true,
      needsServiceSetup: false,
      serviceChecks: [{ name: 'goodkiddo', status: 'running' }],
    });
    const ui = new FakePromptUi({ confirm: [true] });
    const writeEnvUpdates = vi.fn();
    const registerRoom = vi.fn(async () => {
      state = createState({
        env: state.env,
        credentialsConfigured: true,
        credentialKind: 'claude-code-oauth-token',
        configuredChannels: ['discord'],
        registeredGroups: 1,
        needsCredentials: false,
        needsChannel: false,
        needsRegistration: false,
        needsServiceSetup: false,
        serviceChecks: [{ name: 'goodkiddo', status: 'running' }],
      });
    });
    const runVerify = vi.fn(async () => {});

    await _testing.runWizardFlow(
      {
        jid: 'dc:123',
        name: 'Ops',
        folder: 'discord_ops',
        isMain: true,
      },
      {
        ui,
        loadState: () => state,
        writeEnvUpdates,
        reloadEnv: vi.fn(),
        registerRoom,
        runRunners: vi.fn(),
        runService: vi.fn(),
        runVerify,
      },
    );

    expect(writeEnvUpdates).not.toHaveBeenCalled();
    expect(registerRoom).toHaveBeenCalledOnce();
    expect(runVerify).toHaveBeenCalledOnce();
    expect(ui.outroMessage).toContain('Everything looks configured and ready.');
  });

  it('writes missing credentials and channel config before registration', async () => {
    let state = createState();
    const ui = new FakePromptUi({
      text: ['Codex'],
      password: ['oauth-token-123', 'discord-token-123'],
      confirm: [true, false],
      select: ['claude-code-oauth-token', 'discord'],
    });
    const writeEnvUpdates = vi.fn((updates: Record<string, string>) => {
      state = createState({
        env: {
          assistantName: updates.ASSISTANT_NAME,
          discordToken: updates.DISCORD_BOT_TOKEN,
          telegramToken: '',
          claudeCodeOauthToken: updates.CLAUDE_CODE_OAUTH_TOKEN,
          anthropicApiKey: '',
        },
        credentialsConfigured: true,
        credentialKind: 'claude-code-oauth-token',
        configuredChannels: ['discord'],
        needsCredentials: false,
        needsChannel: false,
        needsRegistration: true,
        needsServiceSetup: true,
        serviceChecks: [{ name: 'goodkiddo', status: 'not_found' }],
      });
    });

    await _testing.runWizardFlow(
      {},
      {
        ui,
        loadState: () => state,
        writeEnvUpdates,
        reloadEnv: vi.fn(),
        registerRoom: vi.fn(),
        runRunners: vi.fn(),
        runService: vi.fn(),
        runVerify: vi.fn(),
      },
    );

    expect(writeEnvUpdates).toHaveBeenCalledWith({
      ASSISTANT_NAME: 'Codex',
      CLAUDE_CODE_OAUTH_TOKEN: 'oauth-token-123',
      DISCORD_BOT_TOKEN: 'discord-token-123',
    });
    expect(ui.outroMessage).toContain('Register at least one room.');
  });
});
