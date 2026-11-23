import { ChildProcessWithoutNullStreams, spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { extensions, l10n } from 'vscode';
import { codexWindow, UsageResult, UsageWindow } from './types';

const REQUEST_TIMEOUT_MS = 10_000;

interface AppServerError {
  code: number;
  message: string;
}

interface InitializeResult {
  userAgent: string;
}

interface ChatGptAccount {
  type: 'chatgpt';
  email: string | null;
  planType: string;
}

interface OtherAccount {
  type: 'apiKey' | 'amazonBedrock';
}

interface AccountReadResult {
  account: ChatGptAccount | OtherAccount | null;
  requiresOpenaiAuth: boolean;
}

interface AppServerRateWindow {
  usedPercent: number;
  windowDurationMins: number | null;
  resetsAt: number | null;
}

interface RateLimitSnapshot {
  limitId?: string | null;
  limitName?: string | null;
  primary: AppServerRateWindow | null;
  secondary: AppServerRateWindow | null;
  planType: string | null;
}

interface RateLimitsReadResult {
  rateLimits: RateLimitSnapshot;
  rateLimitsByLimitId?: Record<string, RateLimitSnapshot> | null;
}

type AppServerResult = InitializeResult | AccountReadResult | RateLimitsReadResult;

interface AppServerResponse {
  id?: number;
  result?: AppServerResult;
  error?: AppServerError;
}

type AppServerRequest =
  | {
      method: 'initialize';
      id: number;
      params: {
        clientInfo: {
          name: string;
          title: string;
          version: string;
        };
      };
    }
  | { method: 'account/read'; id: number; params: { refreshToken: boolean } }
  | { method: 'account/rateLimits/read'; id: number };

interface PendingRequest {
  resolve: (response: AppServerResponse) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

interface CodexLaunch {
  command: string;
  args: string[];
}

// Codex 실행 명령 결정
function resolveCodexLaunch(): CodexLaunch {
  const binaryName = process.platform === 'win32' ? 'codex.exe' : 'codex';
  for (const directory of (process.env.PATH ?? '').split(path.delimiter)) {
    const cleanDirectory = directory.trim().replace(/^"|"$/g, '');
    if (!path.isAbsolute(cleanDirectory)) continue;
    const candidate = path.join(cleanDirectory, binaryName);
    if (fs.existsSync(candidate)) return { command: candidate, args: ['app-server'] };
  }
  const bundled = extensions?.getExtension('openai.chatgpt')?.extensionPath;
  if (bundled) {
    const arch = process.arch === 'x64' ? 'x86_64' : 'aarch64';
    const platform = process.platform === 'win32' ? 'windows' : process.platform;
    const candidate = path.join(bundled, 'bin', `${platform}-${arch}`, binaryName);
    if (fs.existsSync(candidate)) return { command: candidate, args: ['app-server'] };
  }
  if (process.platform === 'win32') {
    for (const directory of (process.env.PATH ?? '').split(path.delimiter)) {
      if (!path.isAbsolute(directory)) continue;
      const script = path.join(directory, 'node_modules', '@openai', 'codex', 'bin', 'codex.js');
      if (fs.existsSync(script)) return { command: process.execPath, args: [script, 'app-server'] };
    }
    throw new Error('Codex CLI unavailable');
  }
  return { command: 'codex', args: ['app-server'] };
}

// app-server 조회 연결 관리
class CodexAppServerClient {
  private process: ChildProcessWithoutNullStreams | null = null;
  private startPromise: Promise<void> | null = null;
  private nextRequestId = 1;
  private stdoutBuffer = '';
  private readonly pendingRequests = new Map<number, PendingRequest>();

  // app-server 연결 준비
  private async ensureStarted(): Promise<void> {
    if (!this.startPromise) {
      this.startPromise = this.start();
    }
    await this.startPromise;
  }

  // app-server 프로세스 초기화
  private async start(): Promise<void> {
    const launch = resolveCodexLaunch();
    const child = spawn(launch.command, launch.args, {
      windowsHide: true,
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
    });
    this.process = child;
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => this.handleStdout(chunk));
    child.stderr.resume();
    child.stdin.on('error', () => this.failConnection(child));
    child.on('error', () => this.failConnection(child));
    child.on('close', () => this.failConnection(child));

    try {
      const response = await this.sendRequest({
        method: 'initialize',
        id: this.nextRequestId++,
        params: {
          clientInfo: {
            name: 'claude_codex_usage_monitor',
            title: 'Claude Code Usage & Codex Usage Monitor',
            version: '0.3.5',
          },
        },
      });
      if (response.error || !response.result || !('userAgent' in response.result)) {
        throw new Error('Codex app-server initialization failed');
      }
      this.writeMessage({ method: 'initialized' });
    } catch {
      this.failConnection();
      throw new Error('Codex app-server initialization failed');
    }
  }

  // app-server 응답 행 처리
  private handleStdout(chunk: string): void {
    this.stdoutBuffer += chunk;
    const lines = this.stdoutBuffer.split('\n');
    this.stdoutBuffer = lines.pop() ?? '';
    for (const line of lines) {
      if (!line.trim()) {
        continue;
      }
      try {
        const response: AppServerResponse = JSON.parse(line);
        if (typeof response.id !== 'number') {
          continue;
        }
        const pending = this.pendingRequests.get(response.id);
        if (!pending) {
          continue;
        }
        clearTimeout(pending.timer);
        this.pendingRequests.delete(response.id);
        pending.resolve(response);
      } catch {
        this.failConnection();
      }
    }
  }

  // app-server 메시지 전송
  private writeMessage(message: AppServerRequest | { method: 'initialized' }): void {
    if (!this.process?.stdin.writable) {
      throw new Error('Codex app-server is not writable');
    }
    this.process.stdin.write(`${JSON.stringify(message)}\n`);
  }

  // app-server 요청 응답 대기
  private sendRequest(request: AppServerRequest): Promise<AppServerResponse> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingRequests.delete(request.id);
        reject(new Error('Codex app-server request timed out'));
        this.failConnection();
      }, REQUEST_TIMEOUT_MS);
      this.pendingRequests.set(request.id, { resolve, reject, timer });
      try {
        this.writeMessage(request);
      } catch {
        clearTimeout(timer);
        this.pendingRequests.delete(request.id);
        reject(new Error('Codex app-server request failed'));
        this.failConnection();
      }
    });
  }

  // app-server 계정 조회
  async readAccount(): Promise<AccountReadResult> {
    await this.ensureStarted();
    const response = await this.sendRequest({
      method: 'account/read',
      id: this.nextRequestId++,
      params: { refreshToken: false },
    });
    if (response.error || !response.result || !('account' in response.result)) {
      throw new Error('Codex account read failed');
    }
    return response.result;
  }

  // app-server 사용 한도 조회
  async readRateLimits(): Promise<RateLimitsReadResult> {
    await this.ensureStarted();
    const response = await this.sendRequest({
      method: 'account/rateLimits/read',
      id: this.nextRequestId++,
    });
    if (response.error || !response.result || !('rateLimits' in response.result)) {
      throw new Error('Codex rate limit read failed');
    }
    return response.result;
  }

  // app-server 연결 실패 정리
  private failConnection(expectedChild: ChildProcessWithoutNullStreams | null = this.process): void {
    if (expectedChild && expectedChild !== this.process) {
      return;
    }
    const child = this.process;
    this.process = null;
    this.startPromise = null;
    this.stdoutBuffer = '';
    for (const pending of this.pendingRequests.values()) {
      clearTimeout(pending.timer);
      pending.reject(new Error('Codex app-server connection failed'));
    }
    this.pendingRequests.clear();
    if (child && !child.killed) {
      child.kill();
    }
  }

  // app-server 연결 종료
  dispose(): void {
    this.failConnection();
  }
}

const activeClients = new Set<CodexAppServerClient>();

// 계정 한도 구간 변환
function snapshotWindows(snapshot: RateLimitSnapshot): UsageWindow[] {
  return (
    [
      ['session', snapshot.primary],
      ['weekly', snapshot.secondary],
    ] as const
  )
    .map(
      ([kind, w]) =>
        w &&
        codexWindow(w.usedPercent, w.windowDurationMins, w.resetsAt == null ? null : new Date(w.resetsAt * 1000), kind),
    )
    .filter((window): window is UsageWindow => !!window)
    .sort((a, b) => Number(b.kind === 'session') - Number(a.kind === 'session'));
}

// Codex app-server 사용량 조회
export async function fetchCodexAppServerUsage(): Promise<UsageResult> {
  const appServerClient = new CodexAppServerClient();
  activeClients.add(appServerClient);
  try {
    const accountResult = await appServerClient.readAccount();
    if (!accountResult.account || accountResult.account.type !== 'chatgpt') {
      return { status: 'missing', message: l10n.t('Not logged in to Codex') };
    }
    const rateLimitResult = await appServerClient.readRateLimits();
    const buckets = rateLimitResult.rateLimitsByLimitId;
    const rateLimits = buckets?.codex ?? rateLimitResult.rateLimits;
    const mainId = rateLimits.limitId ?? 'codex';
    const windows = snapshotWindows(rateLimits).map((window): UsageWindow =>
      mainId === 'codex'
        ? window
        : { ...window, kind: 'scoped', label: `${rateLimits.limitName || mainId} ${window.label}` },
    );
    for (const [id, bucket] of Object.entries(buckets ?? {})) {
      if (id === mainId) continue;
      for (const window of snapshotWindows(bucket)) {
        windows.push({ ...window, kind: 'scoped', label: `${bucket.limitName || id} ${window.label}` });
      }
    }
    if (windows.length === 0) {
      return { status: 'missing', message: l10n.t('No Codex rate limit data') };
    }
    return {
      status: 'ok',
      data: {
        windows,
        plan: rateLimits.planType ?? accountResult.account.planType,
        account: accountResult.account.email,
        fetchedAt: new Date(),
        sourceNote: l10n.t('Codex app server live data'),
      },
    };
  } catch {
    return { status: 'error', message: l10n.t('Codex app server unavailable') };
  } finally {
    appServerClient.dispose();
    activeClients.delete(appServerClient);
  }
}

// Codex app-server 연결 종료
export function disposeCodexAppServer(): void {
  for (const client of activeClients) client.dispose();
}
