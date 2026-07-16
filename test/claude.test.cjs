const assert = require('node:assert/strict');
const Module = require('node:module');
const test = require('node:test');

const originalFetch = global.fetch;
const originalLoad = Module._load;
const claudePath = require.resolve('../out/claude');

// VS Code 런타임 번역 대체
function translate(message, ...args) {
  return message.replace(/\{(\d+)\}/g, (_, index) => String(args[Number(index)]));
}

// Claude 조회 의존 모듈 대체
Module._load = function load(request, parent, isMain) {
  if (request === 'vscode') {
    return { l10n: { t: translate } };
  }
  if (request === 'child_process') {
    return {
      exec: (_command, _options, callback) => callback(null, '2.1.207'),
    };
  }
  if (request === 'fs/promises') {
    return {
      readFile: async () =>
        JSON.stringify({
          claudeAiOauth: { accessToken: 'test-token', subscriptionType: 'max' },
        }),
    };
  }
  return originalLoad.call(this, request, parent, isMain);
};

// Claude 조회 모듈 상태 초기화
function loadClaude() {
  delete require.cache[claudePath];
  return require(claudePath);
}

// 테스트 런타임 전역 복원
test.after(() => {
  global.fetch = originalFetch;
  Module._load = originalLoad;
});

// 첫 429 응답 backoff 검증
test('첫 429 응답 이후 캐시가 없어도 추가 요청을 차단한다', async () => {
  let calls = 0;
  global.fetch = async () => {
    calls += 1;
    return { ok: false, status: 429 };
  };
  const { fetchClaudeUsage } = loadClaude();

  const first = await fetchClaudeUsage('credentials.json');
  const second = await fetchClaudeUsage('credentials.json');

  assert.equal(first.status, 'error');
  assert.equal(second.status, 'error');
  assert.equal(calls, 1);
});

// 네트워크 오류 캐시 상태 검증
test('성공 데이터 이후 네트워크 오류가 나면 지연 상태를 표시한다', async () => {
  let calls = 0;
  global.fetch = async () => {
    calls += 1;
    if (calls === 1) {
      return {
        ok: true,
        status: 200,
        text: async () =>
          JSON.stringify({
            five_hour: {
              utilization: 28,
              resets_at: '2026-07-16T02:00:00.000Z',
            },
            seven_day: {
              utilization: 41,
              resets_at: '2026-07-18T00:00:00.000Z',
            },
          }),
      };
    }
    throw new Error('network unavailable');
  };
  const { fetchClaudeUsage } = loadClaude();

  const first = await fetchClaudeUsage('credentials.json');
  const second = await fetchClaudeUsage('credentials.json');

  assert.equal(first.status, 'ok');
  assert.equal(second.status, 'ok');
  assert.equal(second.data.sourceNote, 'Showing last successful data');
});

// 요청 시간 초과 오류 상태 검증
test('AbortError는 요청 시간 초과 오류로 표시한다', async () => {
  global.fetch = async () => {
    const error = new Error('aborted');
    error.name = 'AbortError';
    throw error;
  };
  const { fetchClaudeUsage } = loadClaude();

  const result = await fetchClaudeUsage('credentials.json');

  assert.deepEqual(result, {
    status: 'error',
    message: 'Usage API request timed out',
  });
});
