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
  fetchedAt: Date;
  sourceNote: string | null;
}

// 사용량 조회 결과 상태 모델
export type UsageResult =
  | { status: 'ok'; data: UsageSnapshot }
  | { status: 'missing'; message: string }
  | { status: 'absent'; message: string }
  | { status: 'error'; message: string };
