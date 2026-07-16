const assert = require('node:assert/strict');
const Module = require('node:module');
const test = require('node:test');

const originalLoad = Module._load;

// VS Code 런타임 번역 대체
function translate(message, ...args) {
  return message.replace(/\{(\d+)\}/g, (_, index) => String(args[Number(index)]));
}

// VS Code 런타임 모듈 대체
Module._load = function load(request, parent, isMain) {
  if (request === 'vscode') {
    return { env: { language: 'en' }, l10n: { t: translate } };
  }
  return originalLoad.call(this, request, parent, isMain);
};

const { buildStatusText } = require('../out/view');

// 사용량 테스트 스냅샷 생성
function createSnapshot(now) {
  return {
    windows: [
      {
        kind: 'session',
        label: '5h',
        percent: 37,
        resetsAt: new Date(now + 90 * 60 * 1000),
      },
      {
        kind: 'weekly',
        label: '7d',
        percent: 52,
        resetsAt: new Date(now + 51 * 60 * 60 * 1000),
      },
    ],
    plan: 'max',
    fetchedAt: new Date(now),
    sourceNote: null,
  };
}

// VS Code 런타임 모듈 복원
test.after(() => {
  Module._load = originalLoad;
});

// compact 표시 구간 초기화 시간 검증
test('compact 모드는 5시간 구간의 초기화 시간을 표시한다', () => {
  const originalNow = Date.now;
  const now = Date.parse('2026-07-16T00:00:00.000Z');
  Date.now = () => now;
  try {
    assert.equal(buildStatusText(createSnapshot(now), 'compact'), '5h 37% (1h 30m)');
  } finally {
    Date.now = originalNow;
  }
});

// full 표시 구간별 초기화 시간 검증
test('full 모드는 각 사용량 구간의 초기화 시간을 표시한다', () => {
  const originalNow = Date.now;
  const now = Date.parse('2026-07-16T00:00:00.000Z');
  Date.now = () => now;
  try {
    assert.equal(buildStatusText(createSnapshot(now), 'full'), '5h 37% (1h 30m) · 7d 52% (2d 3h)');
  } finally {
    Date.now = originalNow;
  }
});
