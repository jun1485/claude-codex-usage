import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { l10n } from 'vscode';
import { UsageResult, UsageWindow, WindowKind } from './types';

// 세션 로그 탐색 상한
const MAX_FILES_TO_COLLECT = 24;
const TAIL_READ_BYTES = 256 * 1024;
// 세션 구간 판별 상한 (분)
const SESSION_WINDOW_MAX_MINUTES = 360;

interface CodexRateWindow {
  used_percent?: number | null;
  window_minutes?: number | null;
  resets_at?: number | null;
  resets_in_seconds?: number | null;
}

interface CodexRateLimits {
  primary?: CodexRateWindow | null;
  secondary?: CodexRateWindow | null;
  plan_type?: string | null;
}

interface CodexLogLine {
  timestamp?: string | null;
  payload?: {
    type?: string;
    rate_limits?: CodexRateLimits | null;
  } | null;
  rate_limits?: CodexRateLimits | null;
}

interface CodexRateLimitRecord {
  rateLimits: CodexRateLimits;
  recordedAt: Date;
}

interface CodexAuthData {
  tokens?: {
    id_token?: string;
    account_id?: string;
  };
}

interface CodexIdTokenPayload {
  email?: string;
}

// Codex 세션 디렉터리 기본 경로 결정
export function resolveSessionsPath(customPath: string): string {
  return customPath || path.join(os.homedir(), '.codex', 'sessions');
}

// 현재 Codex 계정 식별 정보 조회
async function readCodexAccount(sessionsDir: string): Promise<string | null> {
  let auth: CodexAuthData;
  try {
    auth = JSON.parse(await fs.readFile(path.join(path.dirname(sessionsDir), 'auth.json'), 'utf8'));
  } catch {
    return null;
  }

  const encodedPayload = auth.tokens?.id_token?.split('.')[1];
  if (encodedPayload) {
    try {
      const payload: CodexIdTokenPayload = JSON.parse(Buffer.from(encodedPayload, 'base64url').toString('utf8'));
      if (payload.email) {
        return payload.email;
      }
    } catch {}
  }
  return auth.tokens?.account_id ?? null;
}

// 이름 역순 우선 순회로 최신 jsonl 파일 수집
async function collectRecentJsonlFiles(dir: string, out: string[], limit: number): Promise<void> {
  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  // 연/월/일 디렉터리 구조 최신 날짜 우선 순회
  entries.sort((a, b) => b.name.localeCompare(a.name));
  for (const entry of entries) {
    if (out.length >= limit) {
      return;
    }
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      await collectRecentJsonlFiles(full, out, limit);
    } else if (entry.isFile() && entry.name.endsWith('.jsonl')) {
      out.push(full);
    }
  }
}

// 파일 끝부분만 부분 읽기
async function readTail(file: string, maxBytes: number): Promise<{ text: string; mtime: Date }> {
  const stat = await fs.stat(file);
  const start = Math.max(0, stat.size - maxBytes);
  const handle = await fs.open(file, 'r');
  try {
    const length = stat.size - start;
    const buffer = Buffer.alloc(length);
    await handle.read(buffer, 0, length, start);
    return { text: buffer.toString('utf8'), mtime: stat.mtime };
  } finally {
    await handle.close();
  }
}

// 로그 라인의 사용량 제한 기록 추출
function extractRateLimitRecord(line: string, fallbackRecordedAt: Date): CodexRateLimitRecord | null {
  try {
    const parsed: CodexLogLine = JSON.parse(line);
    const rateLimits = parsed.payload?.rate_limits ?? parsed.rate_limits ?? null;
    if (!rateLimits) {
      return null;
    }
    const recordedAt = typeof parsed.timestamp === 'string' ? new Date(parsed.timestamp) : fallbackRecordedAt;
    return {
      rateLimits,
      recordedAt: Number.isNaN(recordedAt.getTime()) ? fallbackRecordedAt : recordedAt,
    };
  } catch {
    return null;
  }
}

// 리셋 시각 변환 (epoch 초 또는 기록 시점 기준 남은 초)
function parseResetsAt(window: CodexRateWindow, recordedAt: Date): Date | null {
  if (typeof window.resets_at === 'number') {
    return new Date(window.resets_at * 1000);
  }
  if (typeof window.resets_in_seconds === 'number') {
    return new Date(recordedAt.getTime() + window.resets_in_seconds * 1000);
  }
  return null;
}

// 윈도우 길이(분) 기준 구간 분류 (누락 시 기본 구간)
function classifyWindow(window: CodexRateWindow, fallbackKind: WindowKind): WindowKind {
  if (typeof window.window_minutes !== 'number' || window.window_minutes <= 0) {
    return fallbackKind;
  }
  return window.window_minutes <= SESSION_WINDOW_MAX_MINUTES ? 'session' : 'weekly';
}

// 사용량 구간 변환 (리셋 경과 시 0% 처리)
function toUsageWindow(
  window: CodexRateWindow | null | undefined,
  fallbackKind: WindowKind,
  recordedAt: Date,
): UsageWindow | null {
  if (!window || typeof window.used_percent !== 'number') {
    return null;
  }
  const kind = classifyWindow(window, fallbackKind);
  const resetsAt = parseResetsAt(window, recordedAt);
  // 리셋 시각 경과 데이터 만료 처리
  const expired = resetsAt !== null && resetsAt.getTime() <= Date.now();
  return {
    kind,
    label: kind === 'session' ? '5h' : '7d',
    percent: expired ? 0 : window.used_percent,
    resetsAt: expired ? null : resetsAt,
  };
}

// 최신 세션 로그에서 Codex 사용량 조회
export async function fetchCodexUsage(customSessionsPath: string): Promise<UsageResult> {
  const sessionsDir = resolveSessionsPath(customSessionsPath);
  try {
    await fs.access(sessionsDir);
  } catch {
    // 기본 경로 디렉터리 자체가 없으면 미설치 처리
    return {
      status: customSessionsPath ? 'missing' : 'absent',
      message: l10n.t('No Codex session logs (run codex to populate)'),
    };
  }

  const files: string[] = [];
  await collectRecentJsonlFiles(sessionsDir, files, MAX_FILES_TO_COLLECT);
  if (files.length === 0) {
    return { status: 'missing', message: l10n.t('No Codex session logs (run codex to populate)') };
  }

  let latestUsage: { windows: UsageWindow[]; plan: string | null; recordedAt: Date } | null = null;
  for (const file of files) {
    let tail: { text: string; mtime: Date };
    try {
      tail = await readTail(file, TAIL_READ_BYTES);
    } catch {
      continue;
    }
    const lines = tail.text.split('\n');
    for (let i = lines.length - 1; i >= 0; i -= 1) {
      const line = lines[i];
      if (!line.includes('"rate_limits"')) {
        continue;
      }
      const record = extractRateLimitRecord(line, tail.mtime);
      if (!record) {
        continue;
      }
      const windows = [
        toUsageWindow(record.rateLimits.primary, 'session', record.recordedAt),
        toUsageWindow(record.rateLimits.secondary, 'weekly', record.recordedAt),
      ]
        .filter((w): w is UsageWindow => w !== null)
        .sort((a, b) => (a.kind === 'session' ? 0 : 1) - (b.kind === 'session' ? 0 : 1));
      if (windows.length === 0) {
        continue;
      }
      if (!latestUsage || record.recordedAt.getTime() > latestUsage.recordedAt.getTime()) {
        latestUsage = {
          windows,
          plan: record.rateLimits.plan_type ?? null,
          recordedAt: record.recordedAt,
        };
      }
      break;
    }
  }

  if (latestUsage) {
    return {
      status: 'ok',
      data: {
        windows: latestUsage.windows,
        plan: latestUsage.plan,
        account: await readCodexAccount(sessionsDir),
        fetchedAt: latestUsage.recordedAt,
        sourceNote: l10n.t('Updates from session logs when Codex runs'),
      },
    };
  }

  return { status: 'missing', message: l10n.t('No usage records in session logs (run codex to refresh)') };
}
