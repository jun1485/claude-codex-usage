import * as fs from 'fs/promises';
import { createReadStream } from 'fs';
import { createInterface } from 'readline';
import * as os from 'os';
import * as path from 'path';
import { l10n } from 'vscode';
import { fetchCodexAppServerUsage } from './codex-app-server';
import { codexWindow, UsageResult, UsageWindow } from './types';

const TAIL_READ_BYTES = 256 * 1024;

interface CodexRateWindow {
  used_percent?: number | null;
  window_minutes?: number | null;
  resets_at?: number | null;
  resets_in_seconds?: number | null;
}

interface CodexRateLimits {
  limit_id?: string | null;
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

// Codex 세션 디렉터리 기본 경로 결정
export function resolveSessionsPath(customPath: string): string {
  return customPath || path.join(process.env.CODEX_HOME || path.join(os.homedir(), '.codex'), 'sessions');
}

// 세션 로그 경로 수집
async function collectJsonlFiles(dir: string, files: string[]): Promise<void> {
  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      await collectJsonlFiles(full, files);
    } else if (entry.isFile() && entry.name.endsWith('.jsonl')) {
      files.push(full);
    }
  }
}

// 파일 끝부분만 부분 읽기
async function readTail(file: string, size: number): Promise<string> {
  const start = Math.max(0, size - TAIL_READ_BYTES);
  const handle = await fs.open(file, 'r');
  try {
    const length = size - start;
    const buffer = Buffer.alloc(length);
    const { bytesRead } = await handle.read(buffer, 0, length, start);
    return buffer.toString('utf8', 0, bytesRead);
  } finally {
    await handle.close();
  }
}

// 로그 라인의 사용량 제한 기록 추출
function extractRateLimitRecord(line: string, fallbackRecordedAt: Date): CodexRateLimitRecord | null {
  if (!line.includes('"rate_limits"')) return null;
  try {
    const parsed: CodexLogLine = JSON.parse(line);
    const rateLimits = parsed.payload?.rate_limits ?? parsed.rate_limits ?? null;
    if (
      !rateLimits ||
      (rateLimits.limit_id && rateLimits.limit_id !== 'codex') ||
      ![rateLimits.primary?.used_percent, rateLimits.secondary?.used_percent].some(Number.isFinite)
    ) {
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

const recordCache = new Map<string, { mtime: number; size: number; record: CodexRateLimitRecord | null }>();

// 파일별 최근 사용량 기록 조회
async function readLatestRecord(file: string): Promise<CodexRateLimitRecord | null> {
  const { size, mtime } = await fs.stat(file);
  const cached = recordCache.get(file);
  if (cached?.mtime === mtime.getTime() && cached.size === size) return cached.record;
  const tail = await readTail(file, size);
  const lines = tail.split('\n');
  let record: CodexRateLimitRecord | null = null;
  for (let i = lines.length - 1; i >= 0; i--) {
    record = extractRateLimitRecord(lines[i], mtime);
    if (record) break;
  }
  // 긴 세션에서 꼬리 구간 앞에 남은 기록 복구
  if (!record && size > TAIL_READ_BYTES) {
    const stream = createReadStream(file, { encoding: 'utf8', end: size - 1 });
    const reader = createInterface({ input: stream, crlfDelay: Infinity });
    try {
      for await (const line of reader) record = extractRateLimitRecord(line, mtime) ?? record;
    } finally {
      reader.close();
      stream.destroy();
    }
  }
  recordCache.set(file, { mtime: mtime.getTime(), size, record });
  return record;
}

// 최신 세션 로그에서 Codex 사용량 조회
export async function fetchCodexUsageFromLogs(customSessionsPath: string): Promise<UsageResult> {
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
  await collectJsonlFiles(sessionsDir, files);
  const currentFiles = new Set(files);
  for (const cached of recordCache.keys()) {
    if (!currentFiles.has(cached)) recordCache.delete(cached);
  }
  if (files.length === 0) {
    return { status: 'missing', message: l10n.t('No Codex session logs (run codex to populate)') };
  }

  let latest: CodexRateLimitRecord | null = null;
  for (const file of files) {
    try {
      const record = await readLatestRecord(file);
      if (record && (!latest || record.recordedAt > latest.recordedAt)) latest = record;
    } catch {
      continue;
    }
  }
  if (latest) {
    const { rateLimits, recordedAt } = latest;
    const windows = (
      [
        ['session', rateLimits.primary],
        ['weekly', rateLimits.secondary],
      ] as const
    )
      .map(
        ([kind, window]) =>
          window && codexWindow(window.used_percent, window.window_minutes, parseResetsAt(window, recordedAt), kind),
      )
      .filter((w): w is UsageWindow => !!w)
      .sort((a, b) => Number(b.kind === 'session') - Number(a.kind === 'session'));
    if (windows.length) {
      return {
        status: 'ok',
        data: {
          windows,
          plan: rateLimits.plan_type ?? null,
          account: null,
          fetchedAt: recordedAt,
          historical: true,
          sourceNote: l10n.t('Fallback: session logs update only when Codex runs'),
        },
      };
    }
  }

  return { status: 'missing', message: l10n.t('No usage records in session logs (run codex to refresh)') };
}

// Codex 사용량 최적 소스 조회
export async function fetchCodexUsage(customSessionsPath: string): Promise<UsageResult> {
  if (customSessionsPath) return fetchCodexUsageFromLogs(customSessionsPath);
  const appServerResult = await fetchCodexAppServerUsage();
  if (appServerResult.status !== 'error') {
    return appServerResult;
  }

  // app-server 장애 시 세션 로그 대체
  const logResult = await fetchCodexUsageFromLogs(customSessionsPath);
  return logResult.status === 'ok' || logResult.status === 'absent' ? logResult : appServerResult;
}
