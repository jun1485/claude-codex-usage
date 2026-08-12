import * as vscode from 'vscode';
import { UsageSnapshot, UsageWindow } from './types';

export type DisplayMode = 'compact' | 'full';
export type Severity = 'normal' | 'warning' | 'error';

// 남은 시간 축약 표기 (5d 2h / 3h 12m / 45m)
export function formatRemaining(resetsAt: Date | null): string | null {
  if (!resetsAt) {
    return null;
  }
  const diffMinutes = Math.floor((resetsAt.getTime() - Date.now()) / 60000);
  if (diffMinutes <= 0) {
    return vscode.l10n.t('resetting soon');
  }
  const days = Math.floor(diffMinutes / 1440);
  const hours = Math.floor((diffMinutes % 1440) / 60);
  const minutes = diffMinutes % 60;
  if (days > 0) {
    return `${days}d ${hours}h`;
  }
  if (hours > 0) {
    return `${hours}h ${minutes}m`;
  }
  return `${minutes}m`;
}

// 사용률 정수 표기
function formatPercent(percent: number): string {
  return `${Math.round(percent)}%`;
}

// 대표 구간 선택 (세션 우선)
function pickPrimaryWindow(windows: UsageWindow[]): UsageWindow | null {
  return windows.find((w) => w.kind === 'session') ?? windows.find((w) => w.kind === 'weekly') ?? windows[0] ?? null;
}

// 사용량 구간 상태 문구 구성
function formatWindowStatus(window: UsageWindow): string {
  const remaining = formatRemaining(window.resetsAt);
  return `${window.label} ${formatPercent(window.percent)}${remaining ? ` (${remaining})` : ''}`;
}

// 상태바 본문 텍스트 구성
export function buildStatusText(data: UsageSnapshot, mode: DisplayMode): string {
  const primary = pickPrimaryWindow(data.windows);
  if (!primary) {
    return '--';
  }
  if (mode === 'full') {
    return data.windows
      .filter((w) => w.kind !== 'scoped')
      .map(formatWindowStatus)
      .join(' · ');
  }
  return formatWindowStatus(primary);
}

// 사용률 최고치 기준 경고 단계 판정 (표시 반올림 값 기준)
export function pickSeverity(data: UsageSnapshot, warningThreshold: number, errorThreshold: number): Severity {
  const maxPercent = Math.max(...data.windows.map((w) => Math.round(w.percent)));
  if (maxPercent >= errorThreshold) {
    return 'error';
  }
  if (maxPercent >= warningThreshold) {
    return 'warning';
  }
  return 'normal';
}

// 구간 명칭 변환
function windowDisplayName(window: UsageWindow): string {
  if (window.kind === 'session') {
    return vscode.l10n.t('5-hour');
  }
  if (window.kind === 'weekly') {
    return vscode.l10n.t('Weekly');
  }
  return window.label;
}

// 표시 언어 기준 일시 표기
function formatDateTime(date: Date): string {
  return date.toLocaleString(vscode.env.language, {
    month: 'numeric',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
}

// 리셋 시각 상세 표기
function formatResetDetail(resetsAt: Date | null): string {
  if (!resetsAt) {
    return '';
  }
  const remaining = formatRemaining(resetsAt);
  return ` — ${vscode.l10n.t('resets in {0} ({1})', remaining ?? '', formatDateTime(resetsAt))}`;
}

// 사용률 미니 바 구성
function buildMeter(percent: number): string {
  const filled = Math.min(10, Math.max(0, Math.round(percent / 10)));
  return '▰'.repeat(filled) + '▱'.repeat(10 - filled);
}

// 임계값 초과 구간 경고 아이콘 결정
function severityIcon(percent: number, warningThreshold: number, errorThreshold: number): string {
  const rounded = Math.round(percent);
  if (rounded >= errorThreshold) {
    return '$(error) ';
  }
  if (rounded >= warningThreshold) {
    return '$(warning) ';
  }
  return '';
}

// 상태바 툴팁 마크다운 구성
export function buildTooltip(
  icon: string,
  title: string,
  data: UsageSnapshot,
  warningThreshold: number,
  errorThreshold: number,
): vscode.MarkdownString {
  const planSuffix = data.plan ? ` · ${vscode.l10n.t('Plan')} ${data.plan}` : '';
  const lines: string[] = [`$(${icon}) **${title}**${planSuffix}`];
  if (data.account) {
    lines.push(`${vscode.l10n.t('Current account')}: **${data.account}**`);
  }
  for (const window of data.windows) {
    lines.push(
      `${severityIcon(window.percent, warningThreshold, errorThreshold)}${windowDisplayName(window)}: ${buildMeter(window.percent)} **${formatPercent(window.percent)}**${formatResetDetail(window.resetsAt)}`,
    );
  }
  const sourceSuffix = data.sourceNote ? ` · ${data.sourceNote}` : '';
  lines.push(`${vscode.l10n.t('As of {0}', formatDateTime(data.fetchedAt))}${sourceSuffix}`);

  const markdown = new vscode.MarkdownString(lines.join('\n\n'));
  markdown.supportThemeIcons = true;
  return markdown;
}
