const EXTENSION_ID = "jjju.claude-codex-usage-monitor";
const MARKETPLACE_URL = `https://marketplace.visualstudio.com/items?itemName=${EXTENSION_ID}`;
const GALLERY_QUERY_URL =
  "https://marketplace.visualstudio.com/_apis/public/gallery/extensionquery";
const ISSUE_TITLE = "[Metrics] VS Code Marketplace weekly tracking";
const ISSUE_LABEL = "marketplace-metrics";
const SEARCH_QUERIES = [
  "claude usage",
  "claude code usage",
  "claude usage monitor",
  "codex usage",
  "codex cli usage",
  "codex usage monitor",
  "claude codex usage",
  "claude rate limit",
  "codex rate limit",
  "claude quota",
  "codex quota",
  "ccusage",
];

// Marketplace 확장 검색 결과 조회
async function queryMarketplace(criteria) {
  const response = await fetch(GALLERY_QUERY_URL, {
    method: "POST",
    headers: {
      Accept: "application/json;api-version=7.2-preview.1",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      filters: [
        {
          criteria: [
            { filterType: 8, value: "Microsoft.VisualStudio.Code" },
            ...criteria,
            { filterType: 12, value: "4096" },
          ],
          pageNumber: 1,
          pageSize: 100,
          sortBy: 0,
          sortOrder: 0,
        },
      ],
      assetTypes: [],
      flags: 914,
    }),
  });

  if (!response.ok)
    throw new Error(`Marketplace 조회 실패: ${response.status}`);

  const data = await response.json();
  return data.results?.[0]?.extensions ?? [];
}

// Marketplace 통계 값 추출
function getStatistic(extension, name) {
  return (
    extension.statistics?.find((statistic) => statistic.statisticName === name)
      ?.value ?? 0
  );
}

// Marketplace 확장 식별자 조합
function getExtensionId(extension) {
  return `${extension.publisher.publisherName}.${extension.extensionName}`;
}

// Marketplace 검색어 순위 조회
async function getSearchRank(query) {
  const extensions = await queryMarketplace([{ filterType: 10, value: query }]);
  const index = extensions.findIndex(
    (extension) => getExtensionId(extension) === EXTENSION_ID,
  );
  return index < 0 ? null : index + 1;
}

// Marketplace 공개 지표 스냅샷 생성
async function collectSnapshot() {
  const [extensions, ranks] = await Promise.all([
    queryMarketplace([{ filterType: 7, value: EXTENSION_ID }]),
    Promise.all(SEARCH_QUERIES.map(getSearchRank)),
  ]);
  const extension = extensions.find(
    (item) => getExtensionId(item) === EXTENSION_ID,
  );

  if (!extension)
    throw new Error(`Marketplace 확장 조회 실패: ${EXTENSION_ID}`);

  return {
    collectedAt: new Date().toISOString(),
    phase: process.env.METRICS_PHASE || "weekly",
    version: extension.versions?.[0]?.version ?? "-",
    displayName: extension.displayName,
    description: extension.shortDescription,
    installs: getStatistic(extension, "install"),
    rating: getStatistic(extension, "averagerating"),
    reviews: getStatistic(extension, "ratingcount"),
    ranks: Object.fromEntries(
      SEARCH_QUERIES.map((query, index) => [query, ranks[index]]),
    ),
  };
}

// 이전 스냅샷 데이터 추출
function extractSnapshot(text) {
  const match = text?.match(/<!-- marketplace-snapshot:([A-Za-z0-9+/=]+) -->/);
  if (!match) return null;

  try {
    return JSON.parse(Buffer.from(match[1], "base64").toString("utf8"));
  } catch {
    return null;
  }
}

// 증감 값 표시
function formatDelta(current, previous, digits = 0) {
  if (previous === undefined || previous === null) return "-";
  const delta = current - previous;
  return `${delta > 0 ? "+" : ""}${delta.toFixed(digits)}`;
}

// 검색 순위 값 표시
function formatRank(rank) {
  return rank ?? ">100";
}

// 검색 순위 변화 표시
function formatRankChange(current, previous) {
  if (previous === undefined) return "-";
  if (current === null && previous === null) return "0";
  if (current === null) return "100위 밖";
  if (previous === null) return "100위 진입";
  const delta = previous - current;
  return `${delta > 0 ? "+" : ""}${delta}`;
}

// Markdown 표 셀 안전 처리
function escapeCell(value) {
  return String(value).replaceAll("|", "\\|").replaceAll("\n", " ");
}

// Marketplace 지표 보고서 생성
function renderReport(snapshot, previous) {
  const rankRows = SEARCH_QUERIES.map((query) => {
    const previousRank = previous?.ranks?.[query];
    const previousRankText =
      previousRank === undefined ? "-" : formatRank(previousRank);
    return `| ${query} | ${formatRank(snapshot.ranks[query])} | ${previousRankText} | ${formatRankChange(snapshot.ranks[query], previousRank)} |`;
  }).join("\n");
  const encodedSnapshot = Buffer.from(JSON.stringify(snapshot)).toString(
    "base64",
  );

  return [
    `## ${snapshot.phase} · ${snapshot.collectedAt}`,
    "",
    `[Open in VS Code Marketplace](${MARKETPLACE_URL})`,
    "",
    "| Version | Display name | Description | Installs | Rating | Reviews |",
    "|---|---|---|---:|---:|---:|",
    `| ${snapshot.version} | ${escapeCell(snapshot.displayName)} | ${escapeCell(snapshot.description)} | ${snapshot.installs} (${formatDelta(snapshot.installs, previous?.installs)}) | ${snapshot.rating.toFixed(2)} (${formatDelta(snapshot.rating, previous?.rating, 2)}) | ${snapshot.reviews} (${formatDelta(snapshot.reviews, previous?.reviews)}) |`,
    "",
    "| Search query | Current rank | Previous rank | Change |",
    "|---|---:|---:|---:|",
    rankRows,
    "",
    "Positive rank change means the extension moved closer to rank 1.",
    "",
    `<!-- marketplace-snapshot:${encodedSnapshot} -->`,
  ].join("\n");
}

// GitHub REST API 요청
async function requestGitHub(path, options = {}) {
  const response = await fetch(`https://api.github.com${path}`, {
    ...options,
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${process.env.GITHUB_TOKEN}`,
      "X-GitHub-Api-Version": "2022-11-28",
      ...options.headers,
    },
  });

  if (!response.ok)
    throw new Error(
      `GitHub 요청 실패: ${response.status} ${await response.text()}`,
    );
  return response.status === 204 ? null : response.json();
}

// Marketplace 지표 추적 이슈 조회
async function findMetricsIssue(repository) {
  const issues = await requestGitHub(
    `/repos/${repository}/issues?state=open&labels=${ISSUE_LABEL}&per_page=100`,
  );
  return issues.find((issue) => issue.title === ISSUE_TITLE) ?? null;
}

// Marketplace 지표 추적 이슈 생성
async function createMetricsIssue(repository, report) {
  return requestGitHub(`/repos/${repository}/issues`, {
    method: "POST",
    body: JSON.stringify({
      title: ISSUE_TITLE,
      body: report,
      labels: [ISSUE_LABEL],
    }),
  });
}

// 지표 이슈 최신 스냅샷 조회 (마지막 댓글 페이지부터 역순)
async function findPreviousSnapshot(repository, issue) {
  const lastPage = Math.max(1, Math.ceil(issue.comments / 100));
  for (let page = lastPage; page >= 1; page -= 1) {
    const comments = await requestGitHub(
      `/repos/${repository}/issues/${issue.number}/comments?per_page=100&page=${page}`,
    );
    const snapshot = [...comments]
      .reverse()
      .map((comment) => extractSnapshot(comment.body))
      .find(Boolean);
    if (snapshot) return snapshot;
  }
  return extractSnapshot(issue.body);
}

// Marketplace 지표 이슈 댓글 추가
async function addIssueComment(repository, issueNumber, report) {
  return requestGitHub(`/repos/${repository}/issues/${issueNumber}/comments`, {
    method: "POST",
    body: JSON.stringify({ body: report }),
  });
}

// Marketplace 지표 수집 실행
async function main() {
  const snapshot = await collectSnapshot();
  const repository = process.env.GITHUB_REPOSITORY;

  // 로컬 실행 지표 출력
  if (!process.env.GITHUB_TOKEN || !repository) {
    console.log(renderReport(snapshot, null));
    return;
  }

  const issue = await findMetricsIssue(repository);
  // 최초 지표 추적 이슈 생성
  if (!issue) {
    const createdIssue = await createMetricsIssue(
      repository,
      renderReport(snapshot, null),
    );
    console.log(`Marketplace 지표 이슈 생성: ${createdIssue.html_url}`);
    return;
  }

  // 기존 지표 추적 이슈 갱신
  const previous = await findPreviousSnapshot(repository, issue);
  await addIssueComment(
    repository,
    issue.number,
    renderReport(snapshot, previous),
  );
  console.log(`Marketplace 지표 갱신: ${issue.html_url}`);
}

await main();
