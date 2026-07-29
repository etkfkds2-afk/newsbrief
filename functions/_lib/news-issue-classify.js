// Haiku instead of Sonnet: issue grouping is a straightforward matching task,
// and Sonnet's cost (worsened by its extended-thinking output tokens) made a
// single daily baduk classification run ~$0.06 - too expensive to also run
// general daily on the same Claude budget that article summaries share.
const CLASSIFY_MODEL = 'claude-haiku-4-5-20251001';
const HIGH_ACCURACY_CLASSIFY_MODEL = 'claude-sonnet-5';
const WORKERS_AI_CLASSIFY_MODEL = '@cf/meta/llama-3.3-70b-instruct-fp8-fast';

function buildInstructions(hasExisting, allowStandaloneEvents = false) {
  return `당신은 한국 뉴스 데스크의 편집자다. ${hasExisting ? '이미 분류된 기존 이슈 목록과, ' : ''}아직 분류되지 않은 새 기사 목록을 준다.
${hasExisting ? '\n각 새 기사가 기존 이슈 중 하나와 실제로 같은 사건을 다루면 기존 제목을 그대로 사용한다. 단, 기존 제목의 핵심 단어가 실제 기사에 없거나 번역투·오타라면 기사 근거에 맞는 자연스러운 새 제목으로 교정한다. 같은 사건을 다루는 기존 이슈가 없으면 새로운 이슈를 만든다.\n' : ''}
규칙:
- 같은 인물이 등장해도 구체적인 사건이 다르면 절대 묶지 않는다. 반대로 동일 사건의 후속 보도는 표현이 달라도 함께 묶는다.
- 서로 다른 대회, 다른 라운드, 다른 인물, 다른 사건의 기사는 절대 같은 이슈로 묶지 않는다.
- 급락·하락과 상승·회복·반등처럼 방향이 반대인 보도는 별도 이슈로 분리한다.
- 새로 만드는 이슈는 정말로 같은 사건을 다루는 기사가 2건 이상 있을 때만 만든다.
${allowStandaloneEvents ? '- 예외: 기사 제목에 "대회"라는 단어가 명시된 기사는 단독 1건이어도 반드시 독립 이슈로 만든다. 이런 기사를 기타로 보내지 않는다. 본문에 과거 대회 경력만 언급되거나, 리그·기전·행사·교류 등만 있고 제목에 "대회"가 없는 단독 기사는 기타로 보낸다.\n' : ''}
- 같은 번호를 두 이슈에 중복으로 넣지 않는다.
- 새로 만드는 이슈 제목은 기사에 나온 공식 대회명·사건명·정책명을 최우선으로 사용해 8~22자의 자연스러운 한국어 명사구로 쓴다. 기사 주변 인물, 기관, 지역만 떼어 제목으로 쓰지 않는다. 어색한 번역투, 따옴표, 특수기호를 쓰지 않는다.
- 이슈 제목의 핵심 인물·기관·상품·사건 단어는 해당 묶음 기사 제목이나 요약에 실제로 등장해야 한다. 기사에 없는 단어를 추측해서 만들지 않는다.
  예시: "신진서 삼성화재배 우승", "한국기원 정기이사회 개최", "이세돌 은퇴 이후 근황"
- 반드시 아래 JSON 배열 형식으로만 응답한다. 다른 설명, 주석, 마크다운 코드블록은 절대 쓰지 않는다.

출력 형식: [{"title":"이슈 제목(기존과 같은 사건이면 그 제목 그대로)","indices":[0,3,7]}]`;
}

export function isStandaloneEventArticle(article) {
  return Boolean(standaloneBadukIssueTitle(article));
}

function cleanEventName(value) {
  return String(value || '')
    .replace(/^\s*(?:\[[^\]]+\]|<[^>]+>)\s*/u, '')
    .replace(/^\s*(?:제\s*)?\d+회\s*/u, '')
    .replace(/^(?:\d+일\s+)?[가-힣]{2,10}(?:에서|서)\s*/u, '')
    .replace(/\s+/g, ' ')
    .replace(/\s+(?:개최|개막|성료|결승|우승|정상|펼쳐져|열려).*$/u, '')
    .trim().slice(0, 32);
}

export function standaloneBadukIssueTitle(article) {
  const title = String(article?.title || '').replace(/\s+/g, ' ').trim();
  const first = String(article?.summary || '').split('\n')[0].replace(/^\s*1[.)]\s*/, '').replace(/\s+/g, ' ').trim();
  const eventSummary = first.replace(/^.*?(?:주최한|주관한|개최한|열린)\s*/u, '');
  const eventPattern = /(?:제\s*\d+회\s*)?([가-힣A-Za-z0-9· ]{2,38}?(?:전국)?(?:바둑)?(?:선수권대회|바둑대회|결정전|챌린지\s*바둑\s*리그|바둑\s*리그))/u;
  const titleEvent = title.match(eventPattern)?.[0];
  if (titleEvent && (/(?:대회|선수권대회)/u.test(titleEvent)
    || /(?:개최|개막|성료|라운드|경기|승부|대진)/u.test(title))) return cleanEventName(titleEvent);
  const summaryEvent = eventSummary.match(eventPattern)?.[0];
  if (summaryEvent && /(?:개최|열렸|성료|결승|우승|대회가|대회를)/u.test(first)) return cleanEventName(summaryEvent);
  return '';
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
    ? `기존 이슈 목록:\n${existingIssues.map(issue => `- ${issue.title}${issue.context ? ` — ${issue.context}` : ''}`).join('\n')}\n\n`
    : '';
  return `${existingBlock}새 기사 목록:\n${buildListing(newArticles)}`;
}

const INCIDENT_WORDS = /(?:사망|숨져|숨진|사고|화재|폭발|붕괴|실종|피해)/u;
const FOREIGN_PLACES = ['일본', '중국', '미국', '러시아', '유럽', '프랑스', '독일', '영국', '인도', '태국', '베트남'];
const KOREAN_PLACES = ['서울', '부산', '대구', '인천', '광주', '대전', '울산', '세종', '경기', '강원', '충북', '충남', '전북', '전남', '경북', '경남', '제주', '완주', '완도'];

function placeSet(value, places) {
  const text = String(value || '');
  return new Set(places.filter(place => text.includes(place)));
}

export function hasIncidentLocationConflict(existingContext, article) {
  const incoming = `${article?.title || ''} ${article?.summary || ''}`;
  const existing = String(existingContext || '');
  if (!INCIDENT_WORDS.test(existing) || !INCIDENT_WORDS.test(incoming)) return false;
  const oldForeign = placeSet(existing, FOREIGN_PLACES);
  const newForeign = placeSet(incoming, FOREIGN_PLACES);
  const oldKorean = placeSet(existing, KOREAN_PLACES);
  const newKorean = placeSet(incoming, KOREAN_PLACES);
  if (oldForeign.size && newKorean.size && !newForeign.size) return true;
  if (newForeign.size && oldKorean.size && !oldForeign.size) return true;
  if (oldForeign.size && newForeign.size && ![...oldForeign].some(place => newForeign.has(place))) return true;
  return false;
}

export function hasLegalCaseConflict(existingContext, article) {
  const existing = String(existingContext || '');
  const incoming = `${article?.title || ''} ${article?.summary || ''}`;
  // These are separate legal events even when the subject is the same person.
  // Keep the rule deliberately narrow so ordinary follow-up coverage is not
  // split merely because one headline omits a legal term.
  if (/정치자금법/u.test(existing) && /허위사실공표/u.test(incoming) && !/정치자금법/u.test(incoming)) return true;
  if (/허위사실공표/u.test(existing) && /정치자금법/u.test(incoming) && !/허위사실공표/u.test(incoming)) return true;
  return false;
}

const TOPIC_STOPWORDS = new Set([
  '관련', '사건', '소식', '뉴스', '보도', '발표', '전략', '시장', '전환', '전망', '우려',
  '결과', '영향', '추진', '참여', '진행', '오늘', '이번', '한국', '중국', '미국', '일본'
]);

function topicTokens(value) {
  return [...new Set(String(value || '').match(/[0-9A-Za-z가-힣]{2,}/gu) || [])]
    .filter(token => !TOPIC_STOPWORDS.has(token) && !/^\d+$/.test(token));
}

export function hasExistingTopicMismatch(existingTitle, article) {
  const tokens = topicTokens(existingTitle);
  if (!tokens.length) return false;
  const incoming = `${article?.title || ''} ${article?.summary || ''}`.replace(/\s+/g, '');
  const matches = tokens.filter(token => incoming.includes(token));
  // Existing-issue assignment should have concrete textual evidence. Two
  // shared terms, or one distinctive 3+ character term, still permits normal
  // follow-up headlines while rejecting unrelated celebrity/business stories.
  return matches.length < 2 && !matches.some(token => token.length >= 3);
}

export function rejectConflictingExistingMatches(groups, articles, existingIssues) {
  const issueByTitle = new Map(existingIssues.map(issue => [issue.title, issue]));
  const kept = [], rejectedKeys = [];
  for (const group of groups || []) {
    const existing = issueByTitle.get(group.title);
    if (!existing?.context) { kept.push(group); continue; }
    const accepted = [], rejected = [];
    for (const key of group.url_keys || []) {
      const article = articles.find(item => item.url_key === key);
      (hasIncidentLocationConflict(existing.context, article)
        || hasLegalCaseConflict(existing.title, article)
        || hasExistingTopicMismatch(existing.title, article) ? rejected : accepted).push(key);
    }
    if (accepted.length) kept.push({ ...group, url_keys: accepted });
    rejectedKeys.push(...rejected);
  }
  if (rejectedKeys.length) kept.push({ title: '기타', url_keys: rejectedKeys, misc: true });
  return kept;
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
    const genericMisc = /^(?:기타|그 밖의)(?:\s*(?:바둑\s*)?(?:소식|뉴스|이슈))?$/u.test(title);
    groups.push({ title: genericMisc ? '기타' : title, url_keys: indices.map(i => articles[i].url_key), misc: genericMisc });
  }
  const leftover = articles.map((_, i) => i).filter(i => !used.has(i));
  const standaloneLeftover = allowStandaloneEvents
    ? leftover.filter(i => isStandaloneEventArticle(articles[i]))
    : [];
  for (const index of standaloneLeftover) {
    groups.push({
      title: standaloneBadukIssueTitle(articles[index]) || '바둑 이슈',
      url_keys: [articles[index].url_key]
    });
  }
  const miscLeftover = leftover.filter(i => !standaloneLeftover.includes(i));
  if (miscLeftover.length) {
    groups.push({ title: '기타', url_keys: miscLeftover.map(i => articles[i].url_key), misc: true });
  }
  return groups;
}

async function classifyWithAnthropic(env, articles, existingIssues, allowStandaloneEvents, model) {
  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01'
    },
    body: JSON.stringify({
      model,
      max_tokens: model === HIGH_ACCURACY_CLASSIFY_MODEL ? 16000 : 8000,
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
export async function classifyIssues(env, articles, existingIssues = [], { allowStandaloneEvents = false, highAccuracy = false } = {}) {
  if (!articles.length) return { groups: [], provider: 'none' };
  let anthropicError = '';
  if (env?.ANTHROPIC_API_KEY) {
    try {
      const model = highAccuracy ? HIGH_ACCURACY_CLASSIFY_MODEL : CLASSIFY_MODEL;
      const result = await classifyWithAnthropic(env, articles, existingIssues, allowStandaloneEvents, model);
      return { ...result, provider: 'anthropic', model };
    } catch (error) {
      anthropicError = String(error?.message || error).slice(0, 300);
    }
  }
  if (env?.AI) {
    try {
      return {
        groups: await classifyWithWorkersAi(env, articles, existingIssues, allowStandaloneEvents),
        provider: 'cloudflare', anthropic_error: anthropicError
      };
    } catch (error) {
      return {
        groups: [], provider: 'cloudflare-failed', anthropic_error: anthropicError,
        cloudflare_error: String(error?.message || error).slice(0, 300)
      };
    }
  }
  return { groups: [], provider: anthropicError ? 'anthropic-failed' : 'none', anthropic_error: anthropicError };
}
