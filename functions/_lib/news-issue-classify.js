// Haiku instead of Sonnet: issue grouping is a straightforward matching task,
// and Sonnet's cost (worsened by its extended-thinking output tokens) made a
// single daily baduk classification run ~$0.06 - too expensive to also run
// general daily on the same Claude budget that article summaries share.
const CLASSIFY_MODEL = 'claude-haiku-4-5-20251001';
// Sonnet 경로는 2026-08-10에 제거했다. reset/regroup에 걸려 있던 탓에 수동
// 재분류 한 번이 실제 $0.91을 썼고(월 목표 $4.75의 5분의 1), 응답이 늦어
// 재시도된 실행은 recordClaudeUsage까지 못 가 예산에 기록도 안 됐다.
// 이슈 묶기는 Haiku로 충분하다는 것이 이 파일 맨 위 주석의 원래 판단이었다.
const WORKERS_AI_CLASSIFY_MODEL = '@cf/meta/llama-3.3-70b-instruct-fp8-fast';

function buildInstructions(hasExisting, allowStandaloneEvents = false) {
  return `당신은 한국 뉴스 데스크의 편집자다. ${hasExisting ? '이미 분류된 기존 이슈 목록과, ' : ''}아직 분류되지 않은 새 기사 목록을 준다.
${hasExisting ? '\n각 새 기사가 기존 이슈 중 하나와 실제로 같은 사건을 다루면 기존 제목을 그대로 사용한다. **이 합류를 아끼지 마라.** 제목만 보고 판단하지 말고 요약 내용을 보고, 같은 대회·같은 발표·같은 대국을 다루면 표현이 아무리 달라도 기존 이슈에 넣는다. 기사 하나가 홀로 남는 것보다 같은 사건끼리 모이는 편이 낫다. 단, 기존 제목의 핵심 단어가 실제 기사에 없거나 번역투·오타라면 기사 근거에 맞는 자연스러운 새 제목으로 교정한다. 같은 사건을 다루는 기존 이슈가 없으면 새로운 이슈를 만든다.\n' : ''}
규칙:
- 같은 인물이 등장해도 구체적인 사건이 다르면 절대 묶지 않는다. 반대로 동일 사건의 후속 보도는 표현이 달라도 함께 묶는다.
  묶지 말아야 할 예: "신진서, 카타고에 역전승"과 "신진서 80개월 연속 랭킹 1위"는 다른 사건이다. "신진서, 조상연 상대 136수 불계승", "신진서 9단, 영재에게 한 수 가르쳤다", "[제49기 SG배 명인전] 옅은 지점"도 각각 다른 대국·행사이므로 카타고 대국 이슈에 넣지 않는다.
  반드시 묶어야 할 예: "[박치문의 검은 돌 흰 돌] 신진서 대 카타고", "불완전한 인간, 완벽한 AI에 승리한 비결은?"처럼 제목에 사건 이름이 흐릿해도 본문이 그 대국을 다루면 같은 이슈다. 칼럼·해설·인터뷰도 같은 사건이면 함께 묶는다.
- 대회·대국 이슈에 잡지 발간, 방송 편성, 인사 소식처럼 종류가 다른 소식을 넣지 않는다. 예: "월간 바둑 8월호 발간"은 "쏘팔코사놀 최고기사 결정전"과 다른 소식이다.
- 같은 대회·같은 발표를 다룬 기사는 표현이 달라도 반드시 한 이슈로 모은다. 예: "단양군 노인회장기 대회 개최"와 "단양군, 어르신 건강 증진 위한 한궁·장기·바둑대회 성료"는 같은 대회다. "변상일, 농심신라면배 와일드카드 낙점"과 "랭킹 4위 변상일 합류…농심배 최종 명단 확정"도 같은 발표다. "수협은행, 여자 바둑대회 개막식 개최"도 "Sh수협은행 여자 바둑 최강전 개막"과 같은 대회다.
- 지진·화재·사고처럼 하나의 재해가 원인이 되어 같은 날 이어진 2차 피해(붕괴, 폭발, 화재 등)는 별도 사건이 아니라 같은 사건의 일부로 묶는다. 예: 지진 기사와, 그 지진으로 발생한 건물 붕괴·폭발 기사는 하나의 이슈다.
- 서로 다른 대회, 다른 라운드, 다른 인물, 다른 사건의 기사는 절대 같은 이슈로 묶지 않는다.
- 급락·하락과 상승·회복·반등처럼 방향이 반대인 보도는 별도 이슈로 분리한다.
- 새로 만드는 이슈는 정말로 같은 사건을 다루는 기사가 2건 이상 있을 때만 만든다. 다만 이 조건은 **새 이슈를 만들 때만** 적용된다. 기존 이슈에 합류시키는 것은 1건이어도 반드시 한다.
- 어느 이슈에도 넣지 않고 기타로 보내기 전에 다시 확인한다. 그 기사가 다루는 대회·대국·발표가 위 목록에 이미 있는지 요약까지 읽고 본다. 있으면 기타가 아니라 그 이슈로 보낸다.
${allowStandaloneEvents ? '- 예외: 기사 제목에 "대회"라는 단어가 명시된 기사는 단독 1건이어도 반드시 독립 이슈로 만든다. 이런 기사를 기타로 보내지 않는다. 본문에 과거 대회 경력만 언급되거나, 리그·기전·행사·교류 등만 있고 제목에 "대회"가 없는 단독 기사는 기타로 보낸다.\n' : ''}
- 같은 번호를 두 이슈에 중복으로 넣지 않는다.
- 이번에 만드는 이슈끼리도 중복을 만들지 않는다. 같은 사건·같은 대회를 다룬 기사는 표기가 달라도 반드시 하나의 이슈로 모은다. 예: "Sh수협은행 여자바둑최강전"과 "여자 바둑대회"는 같은 대회이므로 하나다. "부산시장배 전국바둑대회"와 "부산광역시장배 전국 바둑대회"도 하나다. "신진서 카타고 AI 격파"와 "신진서 AI 카타고 대국"도 하나다.
- 지역이나 주최가 다른 대회는 절대 같은 이슈로 묶지 않는다. 대회 성격이 비슷해도 마찬가지다. 예: "영종국제도시배 전국바둑대회"와 "단양군 노인회장기 대회"는 다른 대회다. "영종국제도시배"와 "부산시장배"도, "영일만 사랑배"와 "평택시장배"도 각각 다른 대회다. 대회 이름 앞에 붙은 지역·주최 이름이 다르면 무조건 다른 대회로 본다.
- 다만 같은 대회라도 부문이 다르면 별개다. 예: "하찬석국수배 영재바둑대회"와 "하찬석국수배 어린이 바둑대회"는 참가 부문이 달라 서로 다른 이슈다. 부문·연령·등급이 제목에 다르게 적혀 있으면 합치지 않는다.
- 새로 만드는 이슈 제목은 기사에 나온 공식 대회명·사건명·정책명을 최우선으로 사용해 8~22자의 자연스러운 한국어 명사구로 쓴다. 기사 주변 인물, 기관, 지역만 떼어 제목으로 쓰지 않는다. 어색한 번역투, 따옴표, 특수기호를 쓰지 않는다.
- 이슈 제목의 핵심 인물·기관·상품·사건 단어는 해당 묶음 기사 제목이나 요약에 실제로 등장해야 한다. 기사에 없는 단어를 추측해서 만들지 않는다.
  예시: "신진서 삼성화재배 우승", "한국기원 정기이사회 개최", "이세돌 은퇴 이후 근황"
- 반드시 아래 JSON 배열 형식으로만 응답한다. 다른 설명, 주석, 마크다운 코드블록은 절대 쓰지 않는다.

- main에는 그 이슈를 대표할 기사 번호를 하나 고른다. 사건의 핵심을 가장 잘 담은 기사를 고르고, 사진 위주 기사([포토], 화보)나 다른 소식이 섞인 묶음 기사는 대표로 고르지 않는다. main은 반드시 indices 안에 있어야 한다.

출력 형식: [{"title":"이슈 제목(기존과 같은 사건이면 그 제목 그대로)","indices":[0,3,7],"main":3}]`;
}

// Baduk: a lone article can stand as its own issue when its title names a
// specific official event. General news has no such reliable text pattern,
// so it's gated on an external signal instead - the article already ranking
// in the portal's own popularity data (see is_popular on the article row) -
// rather than trusting the classifier's guess alone on a single report.
// Category-gated on purpose: standaloneBadukIssueTitle's "선수권대회" branch
// matches any "___ championship" title, baduk or not (e.g. a track & field
// 전국종별육상경기선수권대회 article), so it must never run for non-baduk
// articles - real DB rows always carry `category`, so this is reliable in
// production; only ad-hoc test fixtures need to set it explicitly.
export function isStandaloneEventArticle(article) {
  if (article?.category === '바둑') return Boolean(standaloneBadukIssueTitle(article));
  return Boolean(article?.is_popular);
}

// Only reached when the classifier left a standalone-eligible article
// unclassified (see toGroups' leftover pass), so there is no AI-authored
// title to fall back on. Strip the noise a raw scraped headline carries
// (bracket tags, trailing " - 언론사" byline) so these tiles read like the
// AI-authored ones instead of standing out as leftover raw text.
function cleanGeneralIssueTitle(value) {
  return String(value || '')
    .replace(/^\s*(?:\[[^\]]+\]|【[^】]+】|<[^>]+>)\s*/u, '')
    .replace(/\s*[-|–—]\s*[^-|–—]{1,30}$/u, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 40);
}

export function standaloneIssueTitle(article) {
  if (article?.category === '바둑') return standaloneBadukIssueTitle(article);
  if (!article?.is_popular) return '';
  return cleanGeneralIssueTitle(article?.title);
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

// reasons: 어느 규칙이 몇 건을 떨어뜨렸는지 호출부가 기록할 수 있게 채워 준다.
// 이게 없으면 "AI가 못 묶었다"와 "AI는 묶었는데 우리가 버렸다"를 구분할 수
// 없다. 2026-08-10에 기원 살인 보도 8건이 두 번 연속 기타로 갔는데 어느 쪽인지
// 알 방법이 없었다.
export function rejectConflictingExistingMatches(groups, articles, existingIssues, reasons = {}) {
  const issueByTitle = new Map(existingIssues.map(issue => [issue.title, issue]));
  const count = name => { reasons[name] = Number(reasons[name] || 0) + 1; };
  const kept = [], rejectedKeys = [];
  for (const group of groups || []) {
    const existing = issueByTitle.get(group.title);
    if (!existing?.context) { kept.push(group); continue; }
    const accepted = [], rejected = [];
    for (const key of group.url_keys || []) {
      const article = articles.find(item => item.url_key === key);
      let reason = '';
      if (hasIncidentLocationConflict(existing.context, article)) reason = 'incident_location';
      else if (hasLegalCaseConflict(existing.title, article)) reason = 'legal_case';
      else if (hasExistingTopicMismatch(existing.title, article)) reason = 'topic_mismatch';
      if (reason) { count(reason); rejected.push(key); } else accepted.push(key);
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

function toGroups(parsed, articles, existingTitles) {
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
    // needs 2+ articles to justify its own tile, unless the article itself
    // already qualifies as a standalone event (see isStandaloneEventArticle).
    const standaloneEvent = indices.length === 1 && isStandaloneEventArticle(articles[indices[0]]);
    if (!existingTitles.has(title) && indices.length < 2 && !standaloneEvent) continue;
    indices.forEach(i => used.add(i));
    const genericMisc = /^(?:기타|그 밖의)(?:\s*(?:바둑\s*)?(?:소식|뉴스|이슈))?$/u.test(title);
    // AI가 고른 대표 기사. 카드 제목이 이슈와 어긋나지 않게 하려는 것이다.
    // indices 밖을 가리키면 무시한다.
    const mainIndex = Number(entry?.main);
    const mainKey = Number.isInteger(mainIndex) && indices.includes(mainIndex)
      ? articles[mainIndex].url_key : '';
    groups.push({
      title: genericMisc ? '기타' : title,
      url_keys: indices.map(i => articles[i].url_key),
      ...(mainKey && !genericMisc ? { main_key: mainKey } : {}),
      misc: genericMisc
    });
  }
  const leftover = articles.map((_, i) => i).filter(i => !used.has(i));
  const standaloneLeftover = leftover.filter(i => isStandaloneEventArticle(articles[i]));
  for (const index of standaloneLeftover) {
    const article = articles[index];
    groups.push({
      title: standaloneIssueTitle(article) || (article?.category === '바둑' ? '바둑 이슈' : '이슈'),
      url_keys: [article.url_key]
    });
  }
  const miscLeftover = leftover.filter(i => !standaloneLeftover.includes(i));
  if (miscLeftover.length) {
    groups.push({ title: '기타', url_keys: miscLeftover.map(i => articles[i].url_key), misc: true });
  }
  return groups;
}

function buildTitleRewriteInstructions() {
  return `당신은 한국 뉴스 데스크의 편집자다. 아래는 각각 단독으로 소개될 기사 목록이다. 기사마다 8~22자의 자연스러운 한국어 명사구 제목을 새로 짓는다.
규칙:
- 기사에 실제로 나온 핵심 인물·기관·사건·정책명을 최우선으로 쓴다. 기사에 없는 내용을 추측해서 쓰지 않는다.
- 언론사명, 대괄호·꺾쇠 태그, 따옴표, 특수기호를 제목에 쓰지 않는다.
- 반드시 아래 JSON 배열 형식으로만 응답한다. 다른 설명, 주석, 마크다운 코드블록은 절대 쓰지 않는다.

출력 형식: [{"index":0,"title":"제목"}]`;
}

function buildTitleRewritePrompt(articles) {
  return buildListing(articles);
}

// Standalone general tiles (portal-popularity gated, see isStandaloneEventArticle)
// never go through the main clustering prompt with a peer to justify a crafted
// title, so they fall back to the raw scraped headline. This is a small,
// separate call scoped to just those few articles (bounded by the top-12
// popularity gate) so it stays cheap and fast even when the full clustering
// pass for the whole category would be too large to run synchronously.
export async function rewriteStandaloneTitles(env, articles) {
  if (!articles.length || !env?.ANTHROPIC_API_KEY) return { titles: new Map(), usage: {} };
  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: CLASSIFY_MODEL,
        max_tokens: 1024,
        system: buildTitleRewriteInstructions(),
        messages: [{ role: 'user', content: buildTitleRewritePrompt(articles) }]
      })
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) return { titles: new Map(), usage: {} };
    const text = (payload?.content || []).filter(b => b?.type === 'text').map(b => b.text).join('\n');
    const parsed = extractJsonArray(text);
    const titles = new Map();
    if (Array.isArray(parsed)) {
      for (const entry of parsed) {
        const index = Number(entry?.index);
        const title = String(entry?.title || '').trim().slice(0, 40);
        if (Number.isInteger(index) && articles[index] && title) titles.set(articles[index].url_key, title);
      }
    }
    return { titles, usage: payload?.usage || {} };
  } catch {
    return { titles: new Map(), usage: {} };
  }
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
    groups: toGroups(parsed, articles, new Set(existingIssues.map(issue => issue.title))),
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
  return toGroups(parsed, articles, new Set(existingIssues.map(issue => issue.title)));
}

// existingIssues: [{key, title}] — issues already in the cache, so the
// caller can send only genuinely new articles and have them merged in
// instead of re-classifying everything from scratch every run.
export async function classifyIssues(env, articles, existingIssues = [], { allowStandaloneEvents = false } = {}) {
  if (!articles.length) return { groups: [], provider: 'none' };
  let anthropicError = '';
  if (env?.ANTHROPIC_API_KEY) {
    try {
      const result = await classifyWithAnthropic(env, articles, existingIssues, allowStandaloneEvents);
      return { ...result, provider: 'anthropic', model: CLASSIFY_MODEL };
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

// 수집 단계에서 "이 후보가 이미 요약해 둔 기사와 같은 이야기인가"만 묻는다.
// news-dedup.js의 글자 유사도 판정이 놓치는 것을 잡으려고 있다. 실측
// 2026-08-10: 빙그레 부라보콘 보도자료 14건 중 제목 표현이 다른 4건이 유사도
// 문턱을 못 넘어 각각 유료 요약을 받았다. 사람이 보면 명백히 같은 기사다.
//
// 이슈 분류(classifyIssues)와 목적이 다르다. 저쪽은 하루 한 번, 요약을 다 산
// 뒤에 화면을 묶는다. 여기는 요약을 사기 전에 물어서 돈을 아끼는 자리다.
//
// 비용: 실행당 1회. 입력 약 1,200 / 출력 약 50 토큰이면 $0.0015 수준이고,
// 요약 한 건(유료 호출 3회 = $0.0126)만 막아도 여덟 번치 판정값이 나온다.
function buildDuplicateInstructions() {
  return `당신은 한국 뉴스 데스크의 편집자다. 이미 다룬 기사 목록과 새로 들어온 기사 목록을 준다.
새 기사 각각에 대해, 이미 다룬 기사 중 **같은 사건·같은 발표를 다룬 것**이 있으면 그 번호를 찾는다.

규칙:
- 같은 보도자료를 매체마다 다르게 쓴 것은 같은 기사다. 제목 표현이 달라도 묶는다.
- 같은 인물·같은 대회가 나와도 구체적 사건이 다르면 절대 묶지 않는다.
- 다른 라운드, 다른 대국, 다른 경기 결과는 절대 묶지 않는다.
- 같은 연재물의 다른 회차는 절대 묶지 않는다.
- 확신이 없으면 묶지 않는다. 놓치는 것보다 잘못 묶는 것이 나쁘다.
- 반드시 아래 JSON 배열 형식으로만 응답한다. 설명, 주석, 코드블록을 쓰지 않는다.
- 같은 기사가 없는 새 기사는 배열에 넣지 않는다.

출력 형식: [{"new":0,"same":3}]`;
}

// candidates: [{title}], known: [title]. 반환은 Map(후보 index -> 기존 제목).
export async function findDuplicateStories(env, candidates = [], known = []) {
  const empty = { duplicates: new Map(), usage: {} };
  if (!candidates.length || !known.length || !env?.ANTHROPIC_API_KEY) return empty;
  const knownList = known.slice(-40);
  const prompt = `이미 다룬 기사:\n${knownList.map((title, i) => `${i}. ${title}`).join('\n')}\n\n`
    + `새로 들어온 기사:\n${candidates.map((c, i) => `${i}. ${c.title}`).join('\n')}`;
  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: CLASSIFY_MODEL,
        max_tokens: 512,
        system: buildDuplicateInstructions(),
        messages: [{ role: 'user', content: prompt }]
      })
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) return empty;
    const text = (payload?.content || []).filter(b => b?.type === 'text').map(b => b.text).join('\n');
    const parsed = extractJsonArray(text);
    const duplicates = new Map();
    if (Array.isArray(parsed)) {
      for (const entry of parsed) {
        const index = Number(entry?.new);
        const sameIndex = Number(entry?.same);
        if (!Number.isInteger(index) || !candidates[index]) continue;
        if (!Number.isInteger(sameIndex) || !knownList[sameIndex]) continue;
        duplicates.set(index, knownList[sameIndex]);
      }
    }
    return { duplicates, usage: payload?.usage || {}, model: CLASSIFY_MODEL };
  } catch {
    return empty;
  }
}
