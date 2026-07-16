const assert = require('node:assert/strict');
const test = require('node:test');
const { SingleFlight } = require('../out/single-flight');

// 동일 공급자 중복 조회 방지 검증
test('동일 키 요청은 진행 중인 작업 결과를 공유한다', async () => {
  const singleFlight = new SingleFlight();
  let calls = 0;
  let release;
  // 공급자 지연 조회 실행
  const task = () => {
    calls += 1;
    return new Promise((resolve) => {
      release = resolve;
    });
  };

  const first = singleFlight.run('claude:', task);
  const second = singleFlight.run('claude:', task);
  await Promise.resolve();

  assert.strictEqual(first, second);
  assert.equal(calls, 1);
  release('ok');
  assert.deepEqual(await Promise.all([first, second]), ['ok', 'ok']);

  assert.equal(await singleFlight.run('claude:', async () => 'next'), 'next');
});
