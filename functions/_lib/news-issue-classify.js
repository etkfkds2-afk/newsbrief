const CLASSIFY_MODEL = 'claude-sonnet-5';
const WORKERS_AI_CLASSIFY_MODEL = '@cf/meta/llama-3.3-70b-instruct-fp8-fast';

function buildInstructions(hasExisting, allowStandaloneEvents = false) {
  return `당신은 한국 뉴스 데스크의 편집자다. ${hasExisting ? '이미 분류된 기존 이슈 목록과, ' : ''}아직 분류되지 않은 새 기사 목록을 준다.
${hasExisting ? '\n각 새 기사가 기존 이슈 중 하나와 실제로 같은 사건을 다루면, 그 기존 이슈의 제목을 글자 하나 다르지 않게 정확히 그대로 사용해서 묶는다. 같은 사건을 다루는 기존 이슈가 없으면 새로운 이슈를 만든다.\n' : ''}
규칙:
- 서로 다른 대회, 다른 라운드, 다른 인물, 다른 사건의 기사는 절대 같은 이슈로 묶지 않는다.
- 새로 만드는 이슈는 정말로 같은 사건을 다루는 기사가 2건 이상 있을 때만 만든다.
${allowStandaloneEvents ? '- 예외: 제목이나 본문에 고유한 대회·리그·기전·선수권·오픈·바둑 행사·국제 바둑교류가 명시된 기사는 단독 1건이어도 반드시 독립 이슈로 만든다. 이런 기사를 기타로 보내지 않는다.\n' : ''}
- 같은 번호를 두 이슈에 중복으로 넣지 않는다.
- 새로 만드는 이슈 제목은 8~18자 내외의 자연스러운 한국어 명사구로 쓴다. 어색한 번역투, 따옴표, 특수기호를 쓰지 않는다.
  예시: "신진서 삼성화재배 우승", "한국기원 정기이사회 개최", "이세돌 은퇴 이후 근황"
- 반드시 아래 JSON 배열 형식으로만 응답한다. 다른 설명, 주석, 마크다운 코드블록은 절대 쓰지 않는다.

출력 형식: [{"title":"이슈 제목(기존과 같은 사건이면 그 제목 그대로)","indices":[0,3,7]}]`;
}

export function isStandaloneEventArticle(article) {
  return /(?:바둑)?(?:대회|리그|기전|선수권|오픈|행사|축제|국제(?:우호|교류)|스포츠교류|합동훈련)/u
    .test(`${article?.title || ''} ${article?.summary || ''}`);
}

function buildListing(articles) {
  return articles.map((item, index) => {
    const date = String(item.published_at || item.fetched_at || '').slice(0, 10);
    const summary = String(item.summary || '').replace(/\n/g, ' ').slice(0, 80);
    return `${index}. [${date}] ${item.title}${summary ? ` — ${summary}` : ''}`;
  }).join('\n');
}

function buildPrompt(newArticles, existingIssues) {
  const existingBlock = existingIssues.length
    ? `기존 이슈 목록:\n${existingIssues.map(issue => `- ${issue.title}`).join('\n')}\n\n`
    : '';
  return `${existingBlock}새 기사 목록:\n${buildListing(newArticles)}`;
}

function stripFences(value) {
  return String(value || '').replace(/```(?:json)?/gi, '').trim();
}

function extractJsonArray(text) {
  const stripped = stripFences(text);
  try {
    return JSON.parse(stripped);
  } catch {
    const match = stripped.match(/\[[\s\S]*\]/);
    if (!match) return null;
    try {
      return JSON.parse(match[0]);
    } catch {
      return null;
    }
  }
}

function toGroups(parsed, articles, existingTitles, allowStandaloneEvents = false) {
  if (!Array.isArray(parsed)) return [];
  const used = new Set();
  const groups = [];
  for (const entry of parsed) {
    const title = String(entry?.title || '').trim().slice(0, 40);
    const indices = Array.isArray(entry?.indices)
      ? [...new Set(entry.indices)].filter(i => Number.isInteger(i) && i >= 0 && i < articles.length && !used.has(i))
      : [];
    if (!title || !indices.length) continue;
    // A match against an existing issue title is kept at any size (it's
    // extending an already-established story); a brand-new title still
    // needs 2+ articles to justify its own tile.
    const standaloneEvent = allowStandaloneEvents && indices.length === 1 && isStandaloneEventArticle(articles[indices[0]]);
    if (!existingTitles.has(title) && indices.length < 2 && !standaloneEvent) continue;
    indices.forEach(i => used.add(i));
    groups.push({ title, url_keys: indices.map(i => articles[i].url_key) });
  }
  const leftover = articles.map((_, i) => i).filter(i => !used.has(i));
  const standaloneLeftover = allowStandaloneEvents
    ? leftover.filter(i => isStandaloneEventArticle(articles[i]))
    : [];
  for (const index of standaloneLeftover) {
    groups.push({
      title: String(articles[index].title || '바둑 대회').replace(/[“”‘’"']/g, '').trim().slice(0, 40),
      url_keys: [articles[index].url_key]
    });
  }
  const miscLeftover = leftover.filter(i => !standaloneLeftover.includes(i));
  if (miscLeftover.length) {
    groups.push({ title: '기타', url_keys: miscLeftover.map(i => articles[i].url_key), misc: true });
  }
  return groups;
}

async function classifyWithAnthropic(env, articles, existingIssues, allowStandaloneEvents) {
  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01'
    },
    body: JSON.stringify({
      model: CLASSIFY_MODEL,
      max_tokens: 8000,
      system: buildInstructions(existingIssues.length > 0, allowStandaloneEvents),
      messages: [{ role: 'user', content: buildPrompt(articles, existingIssues) }]
    })
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(payload?.error?.message || `Anthropic API ${response.status}`);
  }
  const text = (payload?.content || []).filter(b => b?.type === 'text').map(b => b.text).join('\n');
  const parsed = extractJsonArray(text);
  if (!parsed) throw new Error('Anthropic 응답을 JSON으로 해석하지 못했습니다.');
  return {
    groups: toGroups(parsed, articles, new Set(existingIssues.map(issue => issue.title)), allowStandaloneEvents),
    usage: payload?.usage || {}
  };
}

async function classifyWithWorkersAi(env, articles, existingIssues, allowStandaloneEvents) {
  const result = await env.AI.run(WORKERS_AI_CLASSIFY_MODEL, {
    messages: [
      { role: 'system', content: buildInstructions(existingIssues.length > 0, allowStandaloneEvents) },
      { role: 'user', content: buildPrompt(articles, existingIssues) }
    ],
    max_tokens: 4096,
    temperature: 0
  });
  const text = result?.response || result?.result?.response || '';
  const parsed = extractJsonArray(text);
  if (!parsed) throw new Error(`Cloudflare AI 응답을 JSON으로 해석하지 못했습니다: ${text.slice(0, 300)}`);
  return toGroups(parsed, articles, new Set(existingIssues.map(issue => issue.title)), allowStandaloneEvents);
}

// existingIssues: [{key, title}] — issues already in the cache, so the
// caller can send only genuinely new articles and have them merged in
// instead of re-classifying everything from scratch every run.
export async function classifyIssues(env, articles, existingIssues = [], { allowStandaloneEvents = false } = {}) {
  if (!articles.length) return { groups: [], provider: 'none' };
  let cloudflareError = '';
  if (env?.AI) {
    try {
      return { groups: await classifyWithWorkersAi(env, articles, existingIssues, allowStandaloneEvents), provider: 'cloudflare' };
    } catch (error) {
      cloudflareError = String(error?.message || error).slice(0, 300);
    }
  }
  if (env?.ANTHROPIC_API_KEY) {
    const result = await classifyWithAnthropic(env, articles, existingIssues, allowStandaloneEvents);
    return { ...result, provider: 'anthropic', model: CLASSIFY_MODEL, cloudflare_error: cloudflareError };
  }
  return { groups: [], provider: cloudflareError ? 'cloudflare-failed' : 'none', cloudflare_error: cloudflareError };
}
