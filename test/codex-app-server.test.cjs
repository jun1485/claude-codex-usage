const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const fsp = require('node:fs/promises');
const Module = require('node:module');
const os = require('node:os');
const path = require('node:path');
const { PassThrough } = require('node:stream');
const test = require('node:test');

const originalLoad = Module._load;
let appServerAvailable = true;
let accountEmail = 'first@codex.invalid';
let sessionUsedPercent = 25;
let weeklyUsedPercent = 40;
let buckets;
let accountType = 'chatgpt';

// VS Code 번역 문자열 치환
function translate(message, ...args) {
  return message.replace(/\{(\d+)\}/g, (_, index) => String(args[Number(index)]));
}

// app-server 요청별 응답 생성
function createResponse(message) {
  if (message.method === 'initialize') {
    return { id: message.id, result: { userAgent: 'test-agent' } };
  }
  if (message.method === 'account/read') {
    return {
      id: message.id,
      result: {
        account: { type: accountType, email: accountEmail, planType: 'plus' },
        requiresOpenaiAuth: true,
      },
    };
  }
  if (message.method === 'account/rateLimits/read') {
    return {
      id: message.id,
      result: {
        rateLimitsByLimitId: buckets,
        rateLimits: {
          primary: {
            usedPercent: sessionUsedPercent,
            windowDurationMins: 300,
            resetsAt: Math.floor(Date.now() / 1000) + 3600,
          },
          secondary: {
            usedPercent: weeklyUsedPercent,
            windowDurationMins: 10080,
            resetsAt: Math.floor(Date.now() / 1000) + 86400,
          },
          planType: 'plus',
        },
      },
    };
  }
  return null;
}

// app-server 프로세스 대체
function spawnMock() {
  const child = new EventEmitter();
  child.stdin = new PassThrough();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.killed = false;
  child.kill = () => {
    child.killed = true;
    setImmediate(() => child.emit('close', 0));
    return true;
  };

  if (!appServerAvailable) {
    setImmediate(() => child.emit('error', new Error('codex not found')));
    return child;
  }

  let inputBuffer = '';
  child.stdin.on('data', (chunk) => {
    inputBuffer += chunk.toString('utf8');
    const lines = inputBuffer.split('\n');
    inputBuffer = lines.pop() ?? '';
    for (const line of lines) {
      if (!line) {
        continue;
      }
      const response = createResponse(JSON.parse(line));
      if (response) {
        setImmediate(() => child.stdout.write(`${JSON.stringify(response)}\n`));
      }
    }
  });
  return child;
}

// Codex 조회 의존 모듈 대체
Module._load = function load(request, parent, isMain) {
  if (request === 'vscode') {
    return { l10n: { t: translate } };
  }
  if (request === 'node:fs') return { existsSync: () => true };
  if (request === 'node:child_process') {
    return { spawn: spawnMock };
  }
  return originalLoad.call(this, request, parent, isMain);
};

const { disposeCodexAppServer } = require('../out/codex-app-server');
const { fetchCodexUsage } = require('../out/codex');

// 테스트별 app-server 상태 초기화
test.afterEach(() => {
  disposeCodexAppServer();
  appServerAvailable = true;
  accountEmail = 'first@codex.invalid';
  sessionUsedPercent = 25;
  weeklyUsedPercent = 40;
  accountType = 'chatgpt';
  buckets = undefined;
});

// 테스트 의존 모듈 복원
test.after(() => {
  Module._load = originalLoad;
});

// 세션 로그 작성
async function writeLogFile(dir) {
  await fsp.mkdir(dir, { recursive: true });
  const line = JSON.stringify({
    payload: {
      type: 'token_count',
      rate_limits: {
        primary: { used_percent: 12, window_minutes: 300, resets_in_seconds: 3600 },
      },
    },
  });
  await fsp.writeFile(path.join(dir, 'rollout-fallback.jsonl'), `${line}\n`, 'utf8');
}

// app-server 실시간 사용량 우선 조회 검증
test('app-server 사용량과 현재 계정을 우선 반환한다', async () => {
  const before = Date.now();
  const result = await fetchCodexUsage('');
  const after = Date.now();

  assert.equal(result.status, 'ok');
  assert.equal(result.data.account, 'first@codex.invalid');
  assert.equal(result.data.plan, 'plus');
  assert.equal(result.data.windows[0].percent, 25);
  assert.equal(result.data.windows[1].percent, 40);
  assert.equal(result.data.sourceNote, 'Codex app server live data');
  assert.ok(result.data.fetchedAt.getTime() >= before);
  assert.ok(result.data.fetchedAt.getTime() <= after);
});

// app-server 계정 전환 갱신 검증
test('계정 전환 후 최신 계정 사용량을 반환한다', async () => {
  const first = await fetchCodexUsage('');
  accountEmail = 'second@codex.invalid';
  weeklyUsedPercent = 67;
  const second = await fetchCodexUsage('');

  assert.equal(first.status, 'ok');
  assert.equal(first.data.account, 'first@codex.invalid');
  assert.equal(second.status, 'ok');
  assert.equal(second.data.account, 'second@codex.invalid');
  assert.equal(second.data.windows[1].percent, 67);
});

// app-server 장애 로그 대체 검증
test('app-server를 사용할 수 없으면 세션 로그로 대체한다', async () => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'codex-app-server-fallback-'));
  try {
    appServerAvailable = false;
    await writeLogFile(root);

    const previousHome = process.env.CODEX_HOME;
    process.env.CODEX_HOME = root;
    let result;
    try {
      await writeLogFile(path.join(root, 'sessions'));
      result = await fetchCodexUsage('');
    } finally {
      if (previousHome === undefined) delete process.env.CODEX_HOME;
      else process.env.CODEX_HOME = previousHome;
    }

    assert.equal(result.status, 'ok');
    assert.equal(result.data.windows[0].percent, 12);
    assert.equal(result.data.sourceNote, 'Fallback: session logs update only when Codex runs');
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
});

// 지정 로그 경로의 계정 우선순위 검증
test('별도 세션 경로는 기본 계정의 실시간 값으로 대체하지 않는다', async () => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'codex-custom-'));
  try {
    await writeLogFile(root);
    const result = await fetchCodexUsage(root);
    assert.equal(result.data.windows[0].percent, 12);
    assert.equal(result.data.account, null);
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
});

// 일반 한도와 추가 한도 구분 검증
test('기본 한도와 모델별 한도의 기간과 사용률을 구분한다', async () => {
  buckets = {
    codex: { primary: { usedPercent: 7, windowDurationMins: 300, resetsAt: null } },
    other: { limitName: 'Other', primary: { usedPercent: 61, windowDurationMins: 15, resetsAt: null } },
  };
  const result = await fetchCodexUsage('');
  assert.deepEqual(
    result.data.windows.map(({ kind, label, percent }) => [kind, label, percent]),
    [
      ['session', '5h', 7],
      ['scoped', 'Other 15m', 61],
    ],
  );
});

// 비구독 계정의 과거 로그 혼입 방지 검증
test('API 키 계정에는 과거 구독 사용량을 표시하지 않는다', async () => {
  accountType = 'apiKey';
  assert.equal((await fetchCodexUsage('')).status, 'missing');
});
