const assert = require('node:assert/strict');
const test = require('node:test');
const { setTimeout: delay } = require('node:timers/promises');
const { RetryingWatcher } = require('../out/retrying-watcher');

// 감시 폴더 지연 생성 복구 검증
test('감시 연결 실패와 감시 오류 이후 자동으로 재연결한다', async () => {
  const watcher = new RetryingWatcher(5);
  let attempts = 0;
  let closes = 0;
  let handleError;

  watcher.start((onError) => {
    attempts += 1;
    if (attempts === 1) {
      throw new Error('sessions directory missing');
    }
    handleError = onError;
    return {
      close() {
        closes += 1;
      },
    };
  });

  try {
    await delay(30);
    assert.equal(attempts, 2);

    handleError();
    await delay(30);
    assert.equal(attempts, 3);
    assert.equal(closes, 1);
  } finally {
    watcher.stop();
  }
  assert.equal(closes, 2);
});
