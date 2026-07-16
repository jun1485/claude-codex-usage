import * as fs from 'fs';
import * as vscode from 'vscode';
import { fetchClaudeUsage } from './claude';
import { fetchCodexUsage, resolveSessionsPath } from './codex';
import { RetryingWatcher } from './retrying-watcher';
import { SingleFlight } from './single-flight';
import { buildStatusText, buildTooltip, DisplayMode, pickSeverity, Severity } from './view';
import { UsageResult } from './types';

interface ProviderBinding {
  id: 'claude' | 'codex';
  title: string;
  icon: string;
  item: vscode.StatusBarItem;
  fetch: (customPath: string) => Promise<UsageResult>;
}

interface ExtensionConfig {
  refreshIntervalSeconds: number;
  displayMode: DisplayMode;
  warningThreshold: number;
  errorThreshold: number;
  claudeEnabled: boolean;
  codexEnabled: boolean;
  claudeCredentialsPath: string;
  codexSessionsPath: string;
}

let refreshTimer: ReturnType<typeof setInterval> | undefined;
let watchDebounce: ReturnType<typeof setTimeout> | undefined;
const providerRequests = new SingleFlight<UsageResult>();
const sessionsWatcher = new RetryingWatcher(15_000);

// 사용률 임계값 범위 제한
function normalizeThreshold(value: number): number {
  return Math.min(100, Math.max(0, value));
}

// 사용자 설정 스냅샷 조회
function getConfig(): ExtensionConfig {
  const cfg = vscode.workspace.getConfiguration('claudeCodexUsage');
  const warningThreshold = normalizeThreshold(cfg.get<number>('warningThreshold', 80));
  const errorThreshold = Math.max(warningThreshold, normalizeThreshold(cfg.get<number>('errorThreshold', 95)));
  return {
    refreshIntervalSeconds: Math.max(15, cfg.get<number>('refreshIntervalSeconds', 60)),
    displayMode: cfg.get<DisplayMode>('displayMode', 'compact'),
    warningThreshold,
    errorThreshold,
    claudeEnabled: cfg.get<boolean>('claude.enabled', true),
    codexEnabled: cfg.get<boolean>('codex.enabled', true),
    claudeCredentialsPath: cfg.get<string>('claude.credentialsPath', ''),
    codexSessionsPath: cfg.get<string>('codex.sessionsPath', ''),
  };
}

// 경고 단계별 상태바 배경색 결정
function severityBackground(severity: Severity): vscode.ThemeColor | undefined {
  if (severity === 'error') {
    return new vscode.ThemeColor('statusBarItem.errorBackground');
  }
  if (severity === 'warning') {
    return new vscode.ThemeColor('statusBarItem.warningBackground');
  }
  return undefined;
}

// 조회 결과를 상태바 아이템에 반영
function render(binding: ProviderBinding, result: UsageResult, config: ExtensionConfig): void {
  const { item } = binding;
  if (result.status === 'ok') {
    item.text = `$(${binding.icon}) ${buildStatusText(result.data, config.displayMode)}`;
    item.tooltip = buildTooltip(binding.icon, binding.title, result.data);
    item.backgroundColor = severityBackground(
      pickSeverity(result.data, config.warningThreshold, config.errorThreshold),
    );
  } else {
    item.text = `$(${binding.icon}) --`;
    item.tooltip = `${binding.title}: ${result.message}`;
    item.backgroundColor = undefined;
  }
  item.show();
}

// 활성화된 공급자 전체 갱신
async function refreshAll(bindings: ProviderBinding[]): Promise<void> {
  const config = getConfig();
  await Promise.all(
    bindings.map(async (binding) => {
      const enabled = binding.id === 'claude' ? config.claudeEnabled : config.codexEnabled;
      if (!enabled) {
        binding.item.hide();
        return;
      }
      const customPath = binding.id === 'claude' ? config.claudeCredentialsPath : config.codexSessionsPath;
      const result = await providerRequests.run(`${binding.id}:${customPath}`, () => binding.fetch(customPath));
      const latestConfig = getConfig();
      const stillEnabled = binding.id === 'claude' ? latestConfig.claudeEnabled : latestConfig.codexEnabled;
      if (!stillEnabled) {
        binding.item.hide();
        return;
      }
      render(binding, result, latestConfig);
    }),
  );
}

// Codex 세션 로그 감시 재설정 (변경 감지 시 Codex 사용량 즉시 갱신)
function restartCodexWatcher(bindings: ProviderBinding[]): void {
  sessionsWatcher.stop();
  const config = getConfig();
  if (!config.codexEnabled) {
    return;
  }
  sessionsWatcher.start((handleError) => {
    const watcher = fs.watch(resolveSessionsPath(config.codexSessionsPath), { recursive: true }, () => {
      // 연속 쓰기 이벤트 debounce 후 Codex만 갱신
      if (watchDebounce) {
        clearTimeout(watchDebounce);
      }
      watchDebounce = setTimeout(() => {
        void refreshAll(bindings.filter((binding) => binding.id === 'codex'));
      }, 2000);
    });
    watcher.on('error', handleError);
    return watcher;
  });
}

// 갱신 주기 타이머 재설정
function restartTimer(bindings: ProviderBinding[]): void {
  if (refreshTimer) {
    clearInterval(refreshTimer);
  }
  refreshTimer = setInterval(() => {
    void refreshAll(bindings);
  }, getConfig().refreshIntervalSeconds * 1000);
}

// 상태바 클릭 메뉴 항목 모델
interface MenuPick extends vscode.QuickPickItem {
  action?: 'toggleClaude' | 'toggleCodex' | 'openSettings' | 'refresh';
}

// 공급자 표시 on/off 토글·설정·새로고침 퀵 메뉴 표시
async function showQuickMenu(bindings: ProviderBinding[]): Promise<void> {
  const config = getConfig();
  const onOff = (enabled: boolean): string => (enabled ? vscode.l10n.t('On') : vscode.l10n.t('Off'));
  const items: MenuPick[] = [
    {
      label: `$(claude-usage-logo) ${vscode.l10n.t('Claude Code Usage')}`,
      description: onOff(config.claudeEnabled),
      action: 'toggleClaude',
    },
    {
      label: `$(codex-usage-logo) ${vscode.l10n.t('Codex CLI Usage')}`,
      description: onOff(config.codexEnabled),
      action: 'toggleCodex',
    },
    { label: '', kind: vscode.QuickPickItemKind.Separator },
    {
      label: `$(gear) ${vscode.l10n.t('Open Settings')}`,
      action: 'openSettings',
    },
    {
      label: `$(refresh) ${vscode.l10n.t('Refresh Usage')}`,
      action: 'refresh',
    },
  ];
  const picked = await vscode.window.showQuickPick(items, {
    placeHolder: vscode.l10n.t('Toggle visibility or open settings'),
  });
  if (!picked?.action) {
    return;
  }
  const cfg = vscode.workspace.getConfiguration('claudeCodexUsage');
  switch (picked.action) {
    // 토글 후 갱신된 상태로 메뉴 재표시
    case 'toggleClaude':
      await cfg.update('claude.enabled', !config.claudeEnabled, vscode.ConfigurationTarget.Global);
      void showQuickMenu(bindings);
      break;
    case 'toggleCodex':
      await cfg.update('codex.enabled', !config.codexEnabled, vscode.ConfigurationTarget.Global);
      void showQuickMenu(bindings);
      break;
    case 'openSettings':
      void vscode.commands.executeCommand('workbench.action.openSettings', '@ext:jjju.claude-codex-usage-monitor');
      break;
    case 'refresh':
      void refreshAll(bindings);
      break;
  }
}

// 확장 활성화 시 상태바 아이템 생성·주기 갱신 시작
export function activate(context: vscode.ExtensionContext): void {
  const claudeItem = vscode.window.createStatusBarItem('claudeCodexUsage.claude', vscode.StatusBarAlignment.Right, 101);
  claudeItem.name = vscode.l10n.t('Claude Code Usage');
  claudeItem.command = 'claudeCodexUsage.openMenu';

  const codexItem = vscode.window.createStatusBarItem('claudeCodexUsage.codex', vscode.StatusBarAlignment.Right, 100);
  codexItem.name = vscode.l10n.t('Codex CLI Usage');
  codexItem.command = 'claudeCodexUsage.openMenu';

  const bindings: ProviderBinding[] = [
    {
      id: 'claude',
      title: vscode.l10n.t('Claude Code Usage'),
      icon: 'claude-usage-logo',
      item: claudeItem,
      fetch: fetchClaudeUsage,
    },
    {
      id: 'codex',
      title: vscode.l10n.t('Codex CLI Usage'),
      icon: 'codex-usage-logo',
      item: codexItem,
      fetch: fetchCodexUsage,
    },
  ];

  context.subscriptions.push(
    claudeItem,
    codexItem,
    vscode.commands.registerCommand('claudeCodexUsage.refresh', () => {
      void refreshAll(bindings);
    }),
    // 확장 설정 화면 열기
    vscode.commands.registerCommand('claudeCodexUsage.openSettings', () => {
      void vscode.commands.executeCommand('workbench.action.openSettings', '@ext:jjju.claude-codex-usage-monitor');
    }),
    // 상태바 클릭 퀵 메뉴
    vscode.commands.registerCommand('claudeCodexUsage.openMenu', () => {
      void showQuickMenu(bindings);
    }),
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (event.affectsConfiguration('claudeCodexUsage')) {
        restartTimer(bindings);
        restartCodexWatcher(bindings);
        void refreshAll(bindings);
      }
    }),
  );

  void refreshAll(bindings);
  restartTimer(bindings);
  restartCodexWatcher(bindings);
}

// 확장 비활성화 시 타이머·감시 정리
export function deactivate(): void {
  if (refreshTimer) {
    clearInterval(refreshTimer);
    refreshTimer = undefined;
  }
  if (watchDebounce) {
    clearTimeout(watchDebounce);
    watchDebounce = undefined;
  }
  sessionsWatcher.stop();
}
