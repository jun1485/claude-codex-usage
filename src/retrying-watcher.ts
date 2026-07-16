interface CloseableResource {
  close(): void;
}

type WatchFactory = (handleError: () => void) => CloseableResource;

// 파일 감시 리소스 자동 재연결 관리
export class RetryingWatcher {
  private resource: CloseableResource | undefined;
  private retryTimer: ReturnType<typeof setTimeout> | undefined;
  private factory: WatchFactory | undefined;

  // 파일 감시 재연결 주기 설정
  constructor(private readonly retryDelayMs: number) {}

  // 파일 감시 시작
  start(factory: WatchFactory): void {
    this.stop();
    this.factory = factory;
    this.open();
  }

  // 파일 감시 종료
  stop(): void {
    this.factory = undefined;
    if (this.retryTimer) {
      clearTimeout(this.retryTimer);
      this.retryTimer = undefined;
    }
    this.closeResource();
  }

  // 파일 감시 연결
  private open(): void {
    if (!this.factory) {
      return;
    }
    try {
      this.resource = this.factory(() => this.scheduleRetry());
    } catch {
      this.scheduleRetry();
    }
  }

  // 파일 감시 재연결 예약
  private scheduleRetry(): void {
    this.closeResource();
    if (!this.factory || this.retryTimer) {
      return;
    }
    this.retryTimer = setTimeout(() => {
      this.retryTimer = undefined;
      this.open();
    }, this.retryDelayMs);
  }

  // 파일 감시 리소스 정리
  private closeResource(): void {
    try {
      this.resource?.close();
    } catch {
      // 파일 감시 종료 상태 유지
    }
    this.resource = undefined;
  }
}
