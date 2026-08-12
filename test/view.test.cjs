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
    return {
      env: { language: 'en' },
      l10n: { t: translate },
      MarkdownString: class MarkdownString {
        constructor(value) {
          this.value = value;
        }
      },
    };
  }
  return originalLoad.call(this, request, parent, isMain);
};

const { buildStatusText, buildTooltip, pickSeverity } = require('../out/view');

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
    account: 'user@example.com',
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

// 현재 계정 툴팁 표시 검증
test('툴팁에 현재 계정 이메일을 표시한다', () => {
  const tooltip = buildTooltip('codex-usage-logo', 'Codex CLI Usage', createSnapshot(Date.now()), 80, 95);

  assert.match(tooltip.value, /Current account: \*\*user@example\.com\*\*/);
});

// 표시값·경고 단계 반올림 일치 검증
test('경고 단계는 표시와 같은 반올림 값 기준으로 판정한다', () => {
  const data = {
    windows: [{ kind: 'session', label: '5h', percent: 94.6, resetsAt: null }],
    plan: null,
    account: null,
    fetchedAt: new Date(),
    sourceNote: null,
  };
  assert.equal(pickSeverity(data, 80, 95), 'error');
  assert.equal(pickSeverity({ ...data, windows: [{ ...data.windows[0], percent: 94.4 }] }, 80, 95), 'warning');
});
