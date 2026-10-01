import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, describe, expect, it } from 'vitest';

import { Database } from 'bun:sqlite';

import type { ServiceDef } from '../services/service-defs.js';
import type { ServiceCheck } from '../services/verify-services.js';
import {
  buildVerifySummary,
  detectChannelAuth,
  detectCredentials,
  loadRegisteredGroupsSummary,
} from './verify-state.js';

describe('verify state helpers', () => {
  const tempRoots: string[] = [];

  afterEach(() => {
    for (const root of tempRoots.splice(0)) {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('detects configured credentials from .env', () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'goodkiddo-verify-'));
    tempRoots.push(tempRoot);
    fs.writeFileSync(
      path.join(tempRoot, '.env'),
      'CLAUDE_CODE_OAUTH_TOKEN=test-token\n',
    );

    expect(detectCredentials(tempRoot)).toBe('configured');
  });

  it('detects channel auth from either env source', () => {
    expect(
      detectChannelAuth(
        { DISCORD_BOT_TOKEN: '' },
        { DISCORD_BOT_TOKEN: 'discord-token' },
      ),
    ).toEqual({
      discord: 'configured',
    });
  });

  it('detects telegram auth from either env source', () => {
    expect(
      detectChannelAuth(
        { TELEGRAM_BOT_TOKEN: 'telegram-token' },
        { TELEGRAM_BOT_TOKEN: '' },
      ),
    ).toEqual({
      telegram: 'configured',
    });
  });

  it('loads registered group counts from the sqlite store', () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'goodkiddo-verify-'));
    tempRoots.push(tempRoot);
    const dbPath = path.join(tempRoot, 'messages.db');
    const db = new Database(dbPath);
    db.exec(`
      CREATE TABLE registered_groups (
        jid TEXT PRIMARY KEY,
        agent_type TEXT
      );
    `);
    db.exec(`
      INSERT INTO registered_groups (jid, agent_type) VALUES
        ('group-1', 'claude-code'),
        ('group-2', 'codex'),
        ('group-3', 'codex');
    `);
    db.close();

    expect(loadRegisteredGroupsSummary(dbPath)).toEqual({
      registeredGroups: 3,
      groupsByAgent: {
        'claude-code': 1,
        codex: 2,
      },
    });
  });

  it('builds a successful verification summary when all gates pass', () => {
    const services: ServiceCheck[] = [{ name: 'goodkiddo', status: 'running' }];
    const serviceDefs: ServiceDef[] = [
      {
        kind: 'primary',
        name: 'goodkiddo',
        description: 'GoodKiddo',
        launchdLabel: 'com.goodkiddo',
        logName: 'goodkiddo',
      },
      {
        kind: 'codex',
        name: 'goodkiddo-codex',
        description: 'Codex',
        launchdLabel: 'com.goodkiddo.codex',
        logName: 'goodkiddo-codex',
      },
    ];

    expect(
      buildVerifySummary(
        services,
        serviceDefs,
        'configured',
        { discord: 'configured' },
        2,
        { codex: 1 },
      ),
    ).toMatchObject({
      status: 'success',
      configuredChannels: ['discord'],
      codexConfigured: true,
      reviewConfigured: false,
      servicesSummary: { goodkiddo: 'running' },
    });
  });

  it('fails verification when any required gate is missing', () => {
    const services: ServiceCheck[] = [{ name: 'goodkiddo', status: 'stopped' }];

    expect(
      buildVerifySummary(
        services,
        [],
        'missing',
        {},
        0,
        {},
      ),
    ).toMatchObject({
      status: 'failed',
      configuredChannels: [],
      servicesSummary: { goodkiddo: 'stopped' },
    });
  });
});
