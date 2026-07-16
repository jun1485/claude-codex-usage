const assert = require('node:assert/strict');
const fsp = require('node:fs/promises');
const Module = require('node:module');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const originalLoad = Module._load;
// 테스트 홈 디렉터리 대체 경로
let homeDir = '';

// VS Code 런타임 번역 대체
function translate(message, ...args) {
  return message.replace(/\{(\d+)\}/g, (_, index) => String(args[Number(index)]));
}

// Codex 조회 의존 모듈 대체
Module._load = function load(request, parent, isMain) {
  if (request === 'vscode') {
    return { l10n: { t: translate } };
  }
  if (request === 'os') {
    return { homedir: () => homeDir };
  }
  return originalLoad.call(this, request, parent, isMain);
};

const { fetchCodexUsage } = require('../out/codex');

// 테스트 런타임 전역 복원
test.after(() => {
  Module._load = originalLoad;
});

// 임시 세션 디렉터리 생성
async function createTempDir() {
  return fsp.mkdtemp(path.join(os.tmpdir(), 'codex-usage-test-'));
}

// rate_limits 로그 파일 기록
async function writeLogFile(dir, name, rateLimits, mtime) {
  await fsp.mkdir(dir, { recursive: true });
  const file = path.join(dir, name);
  const line = JSON.stringify({ payload: { type: 'token_count', rate_limits: rateLimits } });
  await fsp.writeFile(file, `${line}\n`, 'utf8');
  if (mtime) {
    await fsp.utimes(file, mtime, mtime);
  }
  return file;
}

// 최신 로그 우선 조회 검증
test('가장 최근 세션 로그의 rate_limits를 사용한다', async () => {
  const root = await createTempDir();
  try {
    const now = Date.now();
    await writeLogFile(
      path.join(root, '2026', '07', '15'),
      'rollout-old.jsonl',
      { primary: { used_percent: 90, window_minutes: 300, resets_in_seconds: 3600 } },
      new Date(now - 24 * 60 * 60 * 1000),
    );
    const newest = await writeLogFile(
      path.join(root, '2026', '07', '16'),
      'rollout-new.jsonl',
      {
        primary: { used_percent: 40, window_minutes: 300, resets_in_seconds: 3600 },
        secondary: { used_percent: 20, window_minutes: 10080, resets_in_seconds: 200000 },
        plan_type: 'plus',
      },
      new Date(now - 60 * 1000),
    );

    const result = await fetchCodexUsage(root);

    assert.equal(result.status, 'ok');
    assert.equal(result.data.plan, 'plus');
    assert.equal(result.data.windows.length, 2);
    assert.equal(result.data.windows[0].kind, 'session');
    assert.equal(result.data.windows[0].percent, 40);
    assert.equal(result.data.windows[1].kind, 'weekly');
    assert.equal(result.data.windows[1].percent, 20);

    // 리셋 시각은 로그 기록 시점(mtime) 기준으로 계산
    const stat = await fsp.stat(newest);
    assert.equal(result.data.windows[0].resetsAt.getTime(), stat.mtime.getTime() + 3600 * 1000);
    assert.equal(result.data.fetchedAt.getTime(), stat.mtime.getTime());
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
});

// 리셋 경과 데이터 만료 처리 검증
test('리셋 시각이 지난 구간은 0%로 만료 처리한다', async () => {
  const root = await createTempDir();
  try {
    await writeLogFile(
      path.join(root, '2026', '07', '16'),
      'rollout-stale.jsonl',
      { primary: { used_percent: 80, window_minutes: 300, resets_in_seconds: 60 } },
      new Date(Date.now() - 2 * 60 * 60 * 1000),
    );

    const result = await fetchCodexUsage(root);

    assert.equal(result.status, 'ok');
    assert.equal(result.data.windows[0].percent, 0);
    assert.equal(result.data.windows[0].resetsAt, null);
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
});

// window_minutes 누락 구간 분류 검증
test('window_minutes가 없으면 primary는 세션 구간으로 분류한다', async () => {
  const root = await createTempDir();
  try {
    const resetsAt = Math.floor(Date.now() / 1000) + 7200;
    await writeLogFile(path.join(root, '2026', '07', '16'), 'rollout-fallback.jsonl', {
      primary: { used_percent: 33, resets_at: resetsAt },
    });

    const result = await fetchCodexUsage(root);

    assert.equal(result.status, 'ok');
    assert.equal(result.data.windows[0].kind, 'session');
    assert.equal(result.data.windows[0].label, '5h');
    assert.equal(result.data.windows[0].resetsAt.getTime(), resetsAt * 1000);
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
});

// 미설치·경로 오류 상태 구분 검증
test('기본 세션 경로가 없으면 absent, 커스텀 경로가 없으면 missing을 반환한다', async () => {
  const root = await createTempDir();
  try {
    homeDir = root;

    const absent = await fetchCodexUsage('');
    assert.equal(absent.status, 'absent');

    const missing = await fetchCodexUsage(path.join(root, 'no-such-dir'));
    assert.equal(missing.status, 'missing');
  } finally {
    homeDir = '';
    await fsp.rm(root, { recursive: true, force: true });
  }
});
