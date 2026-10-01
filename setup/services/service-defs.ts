import fs from 'fs';
import path from 'path';

export type ServiceKind = 'primary' | 'codex' | 'review';

export interface ServiceDef {
  /** Stable topology kind used by setup/verify logic */
  kind: ServiceKind;
  /** systemd unit name / nohup script name */
  name: string;
  /** launchd label */
  launchdLabel: string;
  /** Human-readable description for systemd/launchd */
  description: string;
  /** Log file prefix (e.g. "goodkiddo" → logs/goodkiddo.log) */
  logName: string;
  /** Absolute path to EnvironmentFile (systemd) — loaded before Environment= */
  environmentFile?: string;
  /** Extra Environment= lines for systemd / env dict entries for launchd */
  extraEnv?: Record<string, string>;
}

interface ServiceTemplate {
  kind: ServiceKind;
  name: string;
  launchdLabel: string;
  description: string;
  logName: string;
  envFileName?: string;
  assistantName?: string;
}

const SERVICE_TEMPLATES: ServiceTemplate[] = [
  {
    kind: 'primary',
    name: 'goodkiddo',
    launchdLabel: 'com.goodkiddo',
    description: 'GoodKiddo Personal Assistant (Claude Code)',
    logName: 'goodkiddo',
  },
  {
    kind: 'codex',
    name: 'goodkiddo-codex',
    launchdLabel: 'com.goodkiddo-codex',
    description: 'GoodKiddo Codex Assistant',
    logName: 'goodkiddo-codex',
    envFileName: '.env.codex',
    assistantName: 'codex',
  },
  {
    kind: 'review',
    name: 'goodkiddo-review',
    launchdLabel: 'com.goodkiddo-review',
    description: 'GoodKiddo Codex Review Assistant',
    logName: 'goodkiddo-review',
    envFileName: '.env.codex-review',
    assistantName: 'codex',
  },
];

function materializeServiceDef(
  projectRoot: string,
  template: ServiceTemplate,
): ServiceDef {
  const environmentFile = template.envFileName
    ? path.join(projectRoot, template.envFileName)
    : undefined;

  return {
    kind: template.kind,
    name: template.name,
    launchdLabel: template.launchdLabel,
    description: template.description,
    logName: template.logName,
    environmentFile,
    extraEnv: template.assistantName
      ? {
          ASSISTANT_NAME: template.assistantName,
        }
      : undefined,
  };
}

export function getServiceDefs(projectRoot: string): ServiceDef[] {
  return getAllServiceDefs(projectRoot).filter((def) => {
    if (!def.environmentFile) {
      return true;
    }
    return fs.existsSync(def.environmentFile);
  });
}

export function getAllServiceDefs(projectRoot: string): ServiceDef[] {
  return SERVICE_TEMPLATES.flatMap((template) => {
    return [materializeServiceDef(projectRoot, template)];
  });
}

export function getConfiguredServiceNames(projectRoot: string): string[] {
  return getServiceDefs(projectRoot).map((def) => def.name);
}
