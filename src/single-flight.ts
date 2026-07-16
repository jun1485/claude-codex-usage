// 동일 키 비동기 작업 단일 실행 관리
export class SingleFlight<T> {
  private readonly requests = new Map<string, Promise<T>>();

  // 동일 키 비동기 작업 결과 공유
  run(key: string, task: () => Promise<T>): Promise<T> {
    const existing = this.requests.get(key);
    if (existing) {
      return existing;
    }

    const request = Promise.resolve()
      .then(task)
      .finally(() => {
        if (this.requests.get(key) === request) {
          this.requests.delete(key);
        }
      });
    this.requests.set(key, request);
    return request;
  }
}
