// 사용량 구간 종류
export type WindowKind = 'session' | 'weekly' | 'scoped';

// 사용량 단일 구간 정보
export interface UsageWindow {
  kind: WindowKind;
  label: string;
  percent: number;
  resetsAt: Date | null;
}

// 공급자별 사용량 스냅샷
export interface UsageSnapshot {
  windows: UsageWindow[];
  plan: string | null;
  account: string | null;
  fetchedAt: Date;
  sourceNote: string | null;
  historical?: boolean;
}

// 사용량 조회 결과 상태 모델
export type UsageResult =
  | { status: 'ok'; data: UsageSnapshot }
  | { status: 'missing'; message: string }
  | { status: 'absent'; message: string }
  | { status: 'error'; message: string };

// Codex 한도 구간과 사용률 변환
export function codexWindow(
  percent: number | null | undefined,
  minutes: number | null | undefined,
  resetsAt: Date | null,
  fallback: 'session' | 'weekly',
): UsageWindow | null {
  if (typeof percent !== 'number' || !Number.isFinite(percent) || (resetsAt && resetsAt.getTime() <= Date.now()))
    return null;
  const duration = minutes && minutes > 0 ? minutes : fallback === 'session' ? 300 : 10080;
  const label =
    duration % 1440 === 0 ? `${duration / 1440}d` : duration % 60 === 0 ? `${duration / 60}h` : `${duration}m`;
  return { kind: duration === 300 ? 'session' : duration === 10080 ? 'weekly' : fallback, label, percent, resetsAt };
}
