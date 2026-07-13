import { exec } from 'child_process';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { l10n } from 'vscode';
import { UsageResult, UsageWindow } from './types';

const USAGE_URL = 'https://api.anthropic.com/api/oauth/usage';
// User-Agent 누락 시 저한도 버킷으로 분류되어 429 발생
const FALLBACK_CLI_VERSION = '2.1.207';
let cliVersionPromise: Promise<string> | null = null;

// 설치 방식별 claude-code package.json 후보 경로 구성
function cliPackageJsonCandidates(): string[] {
  const packageRel = path.join('@anthropic-ai', 'claude-code', 'package.json');
  const candidates = [path.join(os.homedir(), '.claude', 'local', 'node_modules', packageRel)];
  if (process.env.LOCALAPPDATA) {
    candidates.push(
      path.join(
        process.env.LOCALAPPDATA,
        'Volta',
        'tools',
        'image',
        'packages',
        '@anthropic-ai',
        'claude-code',
        'node_modules',
        packageRel,
      ),
    );
  }
  if (process.env.APPDATA) {
    candidates.push(path.join(process.env.APPDATA, 'npm', 'node_modules', packageRel));
  }
  candidates.push(path.join('/usr/local/lib/node_modules', packageRel), path.join('/usr/lib/node_modules', packageRel));
  return candidates;
}

// CLI 실행으로 버전 조회
function versionFromCli(): Promise<string | null> {
  return new Promise((resolve) => {
    exec('claude --version', { timeout: 5000, windowsHide: true }, (error, stdout) => {
      resolve(error ? null : stdout.match(/\d+\.\d+\.\d+/)?.[0] ?? null);
    });
  });
}

// 설치 패키지 메타에서 버전 조회
async function versionFromPackageJson(): Promise<string | null> {
  for (const candidate of cliPackageJsonCandidates()) {
    try {
      const parsed: { version?: string } = JSON.parse(await fs.readFile(candidate, 'utf8'));
      if (parsed.version) {
        return parsed.version;
      }
    } catch {
      // 후보 경로 부재 시 다음 후보 진행
    }
  }
  return null;
}

// 로컬 claude CLI 버전 감지 (실패 시 폴백 버전)
function detectCliVersion(): Promise<string> {
  if (!cliVersionPromise) {
    cliVersionPromise = (async () =>
      (await versionFromCli()) ?? (await versionFromPackageJson()) ?? FALLBACK_CLI_VERSION)();
  }
  return cliVersionPromise;
}

interface ClaudeCredentials {
  claudeAiOauth?: {
    accessToken?: string;
    expiresAt?: number;
    subscriptionType?: string;
  };
}

interface ClaudeWindowInfo {
  utilization?: number | null;
  resets_at?: string | null;
}

interface ClaudeLimitEntry {
  kind?: string;
  percent?: number | null;
  resets_at?: string | null;
  scope?: { model?: { display_name?: string | null } | null } | null;
}

interface ClaudeUsageResponse {
  five_hour?: ClaudeWindowInfo | null;
  seven_day?: ClaudeWindowInfo | null;
  limits?: ClaudeLimitEntry[] | null;
}

// 429 수신 시 재시도 유예 시각
let backoffUntil = 0;
let lastResult: UsageResult | null = null;

// Claude 인증 파일 기본 경로 결정
function resolveCredentialsPath(customPath: string): string {
  return customPath || path.join(os.homedir(), '.claude', '.credentials.json');
}

// ISO 문자열 리셋 시각 변환
function parseResetsAt(value: string | null | undefined): Date | null {
  if (!value) {
    return null;
  }
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

// usage 응답의 구간별 사용률 목록 구성
function toWindows(usage: ClaudeUsageResponse): UsageWindow[] {
  const windows: UsageWindow[] = [];
  if (typeof usage.five_hour?.utilization === 'number') {
    windows.push({
      kind: 'session',
      label: '5h',
      percent: usage.five_hour.utilization,
      resetsAt: parseResetsAt(usage.five_hour.resets_at),
    });
  }
  if (typeof usage.seven_day?.utilization === 'number') {
    windows.push({
      kind: 'weekly',
      label: '7d',
      percent: usage.seven_day.utilization,
      resetsAt: parseResetsAt(usage.seven_day.resets_at),
    });
  }
  for (const limit of usage.limits ?? []) {
    const modelName = limit.scope?.model?.display_name;
    if (limit.kind === 'weekly_scoped' && modelName && typeof limit.percent === 'number') {
      windows.push({
        kind: 'scoped',
        label: `${modelName} 7d`,
        percent: limit.percent,
        resetsAt: parseResetsAt(limit.resets_at),
      });
    }
  }
  return windows;
}

// Claude OAuth usage API 조회
export async function fetchClaudeUsage(customCredentialsPath: string): Promise<UsageResult> {
  if (Date.now() < backoffUntil && lastResult) {
    return lastResult;
  }

  let credentials: ClaudeCredentials;
  try {
    const raw = await fs.readFile(resolveCredentialsPath(customCredentialsPath), 'utf8');
    credentials = JSON.parse(raw);
  } catch {
    return { status: 'missing', message: l10n.t('Not logged in to Claude (run claude, then /login)') };
  }

  const token = credentials.claudeAiOauth?.accessToken;
  if (!token) {
    return { status: 'missing', message: l10n.t('Claude OAuth token missing (run claude, then /login)') };
  }

  try {
    const response = await fetch(USAGE_URL, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${token}`,
        'anthropic-beta': 'oauth-2025-04-20',
        'User-Agent': `claude-code/${await detectCliVersion()}`,
        'Content-Type': 'application/json',
      },
    });

    if (response.status === 401 || response.status === 403) {
      return { status: 'error', message: l10n.t('Claude token expired (renews automatically when Claude Code runs)') };
    }
    if (response.status === 429) {
      // 과도 호출 방지 유예 후 마지막 데이터 유지
      backoffUntil = Date.now() + 5 * 60 * 1000;
      return lastResult ?? { status: 'error', message: l10n.t('Usage API rate limited (429)') };
    }
    if (!response.ok) {
      return { status: 'error', message: l10n.t('Usage API error (HTTP {0})', response.status) };
    }

    const usage: ClaudeUsageResponse = JSON.parse(await response.text());
    const windows = toWindows(usage);
    if (windows.length === 0) {
      return { status: 'error', message: l10n.t('No usage data in the API response') };
    }

    lastResult = {
      status: 'ok',
      data: {
        windows,
        plan: credentials.claudeAiOauth?.subscriptionType ?? null,
        fetchedAt: new Date(),
        sourceNote: null,
      },
    };
    return lastResult;
  } catch {
    return lastResult ?? { status: 'error', message: l10n.t('Network error while fetching usage') };
  }
}
