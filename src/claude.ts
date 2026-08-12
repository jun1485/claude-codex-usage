import { exec } from 'child_process';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { l10n } from 'vscode';
import { UsageResult, UsageWindow } from './types';

const USAGE_URL = 'https://api.anthropic.com/api/oauth/usage';
const REQUEST_TIMEOUT_MS = 10_000;
const RATE_LIMIT_BACKOFF_MS = 5 * 60 * 1000;
const RATE_LIMIT_BACKOFF_MAX_MS = 60 * 60 * 1000;
// macOS Keychain 자격증명 서비스명
const KEYCHAIN_SERVICE = 'Claude Code-credentials';
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
      resolve(error ? null : (stdout.match(/\d+\.\d+\.\d+/)?.[0] ?? null));
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

interface ClaudeProfile {
  oauthAccount?: {
    emailAddress?: string;
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
// 자격증명 경로별 캐시 구분 키
let lastCacheKey = '';

// 마지막 성공 데이터 지연 상태 표시
function staleLastResult(): UsageResult | null {
  if (lastResult?.status !== 'ok') {
    return lastResult;
  }
  return {
    status: 'ok',
    data: {
      ...lastResult.data,
      sourceNote: l10n.t('Showing last successful data'),
    },
  };
}

// Claude 인증 파일 기본 경로 결정
function resolveCredentialsPath(customPath: string): string {
  return customPath || path.join(os.homedir(), '.claude', '.credentials.json');
}

// 현재 Claude 계정 이메일 조회
async function readClaudeAccount(customCredentialsPath: string): Promise<string | null> {
  if (customCredentialsPath) {
    return null;
  }
  try {
    const profile: ClaudeProfile = JSON.parse(await fs.readFile(path.join(os.homedir(), '.claude.json'), 'utf8'));
    return profile.oauthAccount?.emailAddress ?? null;
  } catch {
    return null;
  }
}

// macOS Keychain 자격증명 조회
function credentialsFromKeychain(): Promise<string | null> {
  return new Promise((resolve) => {
    exec(`security find-generic-password -s "${KEYCHAIN_SERVICE}" -w`, { timeout: 5000 }, (error, stdout) => {
      resolve(error ? null : stdout.trim() || null);
    });
  });
}

// 자격증명 파일·Keychain 순차 조회
async function readCredentials(customPath: string): Promise<ClaudeCredentials | null> {
  try {
    return JSON.parse(await fs.readFile(resolveCredentialsPath(customPath), 'utf8'));
  } catch {
    // 커스텀 경로 지정 시 Keychain 폴백 미적용
    if (customPath || process.platform !== 'darwin') {
      return null;
    }
  }
  const keychainRaw = await credentialsFromKeychain();
  if (!keychainRaw) {
    return null;
  }
  try {
    return JSON.parse(keychainRaw);
  } catch {
    return null;
  }
}

// Claude Code 미설치 여부 판별
async function isClaudeAbsent(): Promise<boolean> {
  try {
    await fs.access(path.join(os.homedir(), '.claude'));
    return false;
  } catch {
    return true;
  }
}

// Retry-After 헤더 기반 429 유예 시간 결정
function resolveBackoffMs(retryAfter: string | null): number {
  const seconds = Number(retryAfter);
  if (!Number.isFinite(seconds) || seconds <= 0) {
    return RATE_LIMIT_BACKOFF_MS;
  }
  return Math.min(seconds * 1000, RATE_LIMIT_BACKOFF_MAX_MS);
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
  // 자격증명 경로 변경 시 캐시·유예 초기화
  const account = await readClaudeAccount(customCredentialsPath);
  const cacheKey = `${resolveCredentialsPath(customCredentialsPath)}:${account ?? ''}`;
  if (cacheKey !== lastCacheKey) {
    lastCacheKey = cacheKey;
    lastResult = null;
    backoffUntil = 0;
  }

  // 429 유예 기간 추가 요청 차단
  if (Date.now() < backoffUntil) {
    return (
      staleLastResult() ?? {
        status: 'error',
        message: l10n.t('Usage API rate limited (429)'),
      }
    );
  }

  const credentials = await readCredentials(customCredentialsPath);
  if (!credentials) {
    // 기본 경로에 흔적 자체가 없으면 미설치 처리
    if (!customCredentialsPath && (await isClaudeAbsent())) {
      return {
        status: 'absent',
        message: l10n.t('Not logged in to Claude (run claude, then /login)'),
      };
    }
    return {
      status: 'missing',
      message: l10n.t('Not logged in to Claude (run claude, then /login)'),
    };
  }

  const oauth = credentials.claudeAiOauth;
  const token = oauth?.accessToken;
  if (!token) {
    return {
      status: 'missing',
      message: l10n.t('Claude OAuth token missing (run claude, then /login)'),
    };
  }

  // 만료 토큰 사전 차단 (불필요한 401 요청 방지)
  if (typeof oauth?.expiresAt === 'number' && Date.now() >= oauth.expiresAt) {
    return {
      status: 'error',
      message: l10n.t('Claude token expired (renews automatically when Claude Code runs)'),
    };
  }

  const cliVersion = await detectCliVersion();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch(USAGE_URL, {
      method: 'GET',
      signal: controller.signal,
      headers: {
        Authorization: `Bearer ${token}`,
        'anthropic-beta': 'oauth-2025-04-20',
        'User-Agent': `claude-code/${cliVersion}`,
        'Content-Type': 'application/json',
      },
    });

    if (response.status === 401 || response.status === 403) {
      return {
        status: 'error',
        message: l10n.t('Claude token expired (renews automatically when Claude Code runs)'),
      };
    }
    if (response.status === 429) {
      // 과도 호출 방지 유예 후 마지막 데이터 유지
      backoffUntil = Date.now() + resolveBackoffMs(response.headers.get('retry-after'));
      return (
        staleLastResult() ?? {
          status: 'error',
          message: l10n.t('Usage API rate limited (429)'),
        }
      );
    }
    if (!response.ok) {
      return {
        status: 'error',
        message: l10n.t('Usage API error (HTTP {0})', response.status),
      };
    }

    const usage: ClaudeUsageResponse = JSON.parse(await response.text());
    const windows = toWindows(usage);
    if (windows.length === 0) {
      return {
        status: 'error',
        message: l10n.t('No usage data in the API response'),
      };
    }

    lastResult = {
      status: 'ok',
      data: {
        windows,
        plan: oauth?.subscriptionType ?? null,
        account,
        fetchedAt: new Date(),
        sourceNote: null,
      },
    };
    return lastResult;
  } catch (error) {
    const staleResult = staleLastResult();
    if (staleResult) {
      return staleResult;
    }
    return {
      status: 'error',
      message: l10n.t(
        error instanceof Error && error.name === 'AbortError'
          ? 'Usage API request timed out'
          : 'Network error while fetching usage',
      ),
    };
  } finally {
    clearTimeout(timeout);
  }
}
