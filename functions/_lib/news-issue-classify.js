// Haiku instead of Sonnet: issue grouping is a straightforward matching task,
// and Sonnet's cost (worsened by its extended-thinking output tokens) made a
// single daily baduk classification run ~$0.06 - too expensive to also run
// general daily on the same Claude budget that article summaries share.
const CLASSIFY_MODEL = 'claude-haiku-4-5-20251001';
const WORKERS_AI_CLASSIFY_MODEL = '@cf/meta/llama-3.3-70b-instruct-fp8-fast';

function buildInstructions(hasExisting, allowStandaloneEvents = false) {
  return `당신은 한국 뉴스 데스크의 편집자다. ${hasExisting ? '이미 분류된 기존 이슈 목록과, ' : ''}아직 분류되지 않은 새 기사 목록을 준다.
${hasExisting ? '\n각 새 기사가 기존 이슈 중 하나와 실제로 같은 사건을 다루면, 그 기존 이슈의 제목을 글자 하나 다르지 않게 정확히 그대로 사용해서 묶는다. 같은 사건을 다루는 기존 이슈가 없으면 새로운 이슈를 만든다.\n' : ''}
규칙:
- [인물:이름] 표시는 여러 제목에 반복된 인명이다. 같은 인물의 같은 사건이면 빠뜨리지 말고 묶되, 인물만 같고 사건이 다르면 분리한다.
- 같은 기업·업종이라는 이유만으로 묶지 않는다. 구체적인 사건·발표·판결·경기와 진행 방향까지 같아야 같은 이슈다.
- 서로 다른 대회·라운드·인물·지역·사건, 또는 급락과 회복처럼 방향이 반대인 기사는 절대 같이 묶지 않는다.
- 새로 만드는 이슈는 정말로 같은 사건을 다루는 기사가 2건 이상 있을 때만 만든다.
${allowStandaloneEvents ? '- 예외: 제목에 대회·선수권이 있거나 요약 첫 문장에 현재 열린 정식 바둑대회명이 있으면 단독 1건도 독립 이슈로 만든다. 과거 경력만 언급한 기사는 제외한다.\n' : ''}
- 같은 번호를 두 이슈에 중복으로 넣지 않는다.
- 제목은 핵심 인물·기관과 구체적인 결과가 드러나는 8~18자의 자연스러운 한국어 명사구로 쓴다. 조사 "와/과"로 사건을 억지로 잇지 말고 "논란", "관련 소식", 업종명만으로 뭉뚱그리지 않는다.
  예시: "신진서 삼성화재배 우승", "한국기원 정기이사회 개최", "이세돌 은퇴 이후 근황"
- 반드시 아래 JSON 배열 형식으로만 응답한다. 다른 설명, 주석, 마크다운 코드블록은 절대 쓰지 않는다.

출력 형식: [{"title":"이슈 제목(기존과 같은 사건이면 그 제목 그대로)","indices":[0,3,7]}]`;
}

function cleanEventTitle(value) {
  return String(value || '')
    .replace(/^(?:20\d{2}\s*|제\s*\d+\s*회\s*)+/u, '')
    .replace(/\s+/g, ' ')
    .replace(/(선수권대회|바둑대회|대회).+$/u, '$1')
    .replace(/(대회)(?:가|이|은|는|에서|를|을)?$/u, '$1')
    .replace('부산광역시장배', '부산시장배')
    .replace('고양특례시장배', '고양시장배')
    .replace('강원특별자치도 장애인', '강원장애인')
    .replace(/하찬석국수배/u, '하찬석 국수배')
    .trim()
    .slice(0, 40);
}

function knownTournamentTitle(value) {
  const text = String(value || '').replace(/\s+/g, ' ');
  const rules = [
    [/대한체육회장배/u, '대한체육회장배 전국바둑선수권대회'],
    [/광주광역시체육회장배/u, '광주광역시체육회장배 학생바둑대회'],
    [/부산(?:광역)?시장배/u, '부산시장배 전국바둑대회'],
    [/평택시장배/u, '평택시장배 전국바둑대회'],
    [/하찬석\s*국수배|하찬석국수배/u, '하찬석 국수배 영재바둑대회'],
    [/영일만\s*사랑배/u, '영일만 사랑배 전국바둑대회'],
    [/부안군수배/u, '부안군수배 전국동호인바둑대회'],
    [/영종(?:국제도시배|바둑대회)|영종구청소년수련관/u, '영종국제도시배 바둑대회'],
    [/고양(?:특례)?시장배|고양시장.*학생.*바둑/u, '고양시장배 학생바둑대회'],
    [/강원.*장애인.*바둑대회/u, '강원장애인 바둑대회'],
    [/단양군.*노인회장기/u, '단양군 노인회장기대회'],
    [/구리시.*바둑대회|구리시장기/u, '구리시 바둑대회'],
    [/대전.*어르신.*바둑.*장기대회|대한노인회 대전/u, '대전 어르신 바둑장기대회'],
    [/무안군.*청소년.*바둑대회|무안군.*상숙시/u, '무안군 청소년바둑대회']
  ];
  return rules.find(([pattern]) => pattern.test(text))?.[1] || '';
}

export function standaloneEventTitle(article) {
  const title = String(article?.title || '').replace(/[“”‘’"']/g, '').trim();
  const firstSummary = String(article?.summary || '').split('\n')[0].replace(/^\s*\d+\)\s*/u, '').trim();
  const known = knownTournamentTitle(`${title} ${firstSummary}`);
  if (known) return known;
  const historicalMention = /(?:과거|경력|출전한 적|참가한 적|우승한 적)/u.test(firstSummary);
  if (/대회/u.test(title)) {
    return cleanEventTitle(title
      .replace(/[,·…].*$/u, '')
      .replace(/\s+(?:개최|성료|열려|우승|돌입).*$/u, ''));
  }
  const numberedEvent = firstSummary.match(/제\s*\d+\s*회\s*([가-힣A-Za-z0-9· ]{2,36}?(?:바둑선수권대회|바둑대회|선수권대회))/u);
  if (!historicalMention && numberedEvent?.[1]) return cleanEventTitle(numberedEvent[1]);
  const namedEvent = firstSummary.match(/([가-힣A-Za-z0-9· ]{2,36}?(?:바둑선수권대회|바둑대회|선수권대회))/u);
  if (!historicalMention && namedEvent?.[1]) return cleanEventTitle(namedEvent[1]);
  if (/선수권/u.test(title)) {
    return cleanEventTitle(title
      .replace(/[,·…].*$/u, '')
      .replace(/\s+(?:개최|성료|열려|우승|돌입).*$/u, ''));
  }
  return '';
}

export function isStandaloneEventArticle(article) {
  return Boolean(standaloneEventTitle(article));
}

const KOREAN_SURNAMES = '김이박최정강조윤장임한오서신권황안송류홍전고문양손배백허유남심노하곽성차주우구민진엄채원천방공현함변염여추도소석선설마길연위표명기반왕금옥육인맹제모탁국어은편용예경봉사부가복태목형피두지감음빈동온호범좌';
const PERSON_FALSE_POSITIVES = new Set(['이렇게','이후로','이상한','이대로','한국인','한사람','한가운데','김부장','신기록','신제품','신도시','최고치','최대치','정상화','정치권','장기간','임시직','전국민','전세계']);

export function repeatedPersonHints(articles) {
  const articleNames = articles.map(article => {
    const names = new Set();
    for (const token of String(article?.title || '').match(/[가-힣]+/gu) || []) {
      if (token.length < 3 || !KOREAN_SURNAMES.includes(token[0])) continue;
      const candidate = token.slice(0, 3);
      if (!PERSON_FALSE_POSITIVES.has(candidate)) names.add(candidate);
    }
    return names;
  });
  const counts = new Map();
  for (const names of articleNames) for (const name of names) counts.set(name, (counts.get(name) || 0) + 1);
  return articleNames.map(names => [...names].filter(name => counts.get(name) >= 2).slice(0, 2));
}

const SERIOUS_CASE_WORDS = /(?:살해|납치|유괴|시신|증거\s*인멸|범행|피해자|용의자)/u;

export function mergeRepeatedPersonCases(groups, articles) {
  const next = (groups || []).map(group => ({ ...group, url_keys: [...(group.url_keys || [])] }));
  const hints = repeatedPersonHints(articles);
  const articleByKey = new Map(articles.map((article, index) => [article.url_key, { article, names: hints[index] }]));
  const repeatedNames = new Set(hints.flat());
  for (const name of repeatedNames) {
    const relatedKeys = articles.filter((article, index) =>
      hints[index].includes(name) && SERIOUS_CASE_WORDS.test(`${article.title || ''} ${article.summary || ''}`)
    ).map(article => article.url_key);
    if (relatedKeys.length < 2) continue;
    const relatedSet = new Set(relatedKeys);
    const target = next.find(group => !group.misc && String(group.title || '').includes(name)
      && group.url_keys.some(key => relatedSet.has(key)));
    if (!target) continue;
    for (const group of next) {
      if (group === target) continue;
      group.url_keys = group.url_keys.filter(key => !relatedSet.has(key));
    }
    target.url_keys = [...new Set([...target.url_keys, ...relatedKeys])]
      .filter(key => articleByKey.has(key));
  }
  return next.filter(group => group.url_keys.length > 0);
}

export function normalizeIssueTitle(title, articles = []) {
  const raw = String(title || '').replace(/[“”‘’"']/g, '').trim().slice(0, 40);
  const context = `${raw} ${articles.map(article => `${article?.title || ''} ${article?.summary || ''}`).join(' ')}`;
  const knownEvent = knownTournamentTitle(context);
  if (knownEvent) return knownEvent;
  if (/한돌/u.test(context) && /(?:한중|중국)/u.test(context) && /청소년/u.test(context)) return '한중청소년교류 한돌 지원';
  if (/하찬석국수배|하찬석 국수배/u.test(context)) return '하찬석 국수배 영재바둑대회';
  if (/영종/u.test(context) && /국제도시배/u.test(context)) return '영종국제도시배 바둑대회';
  if (/무안군/u.test(context) && /청소년/u.test(context) && /바둑대회/u.test(context)) return '무안군 청소년바둑대회';
  if (/영일만/u.test(context) && /바둑대회/u.test(context)) return '영일만 사랑배 전국바둑대회';
  if (/강원/u.test(context) && /장애인/u.test(context) && /바둑대회/u.test(context)) return '강원장애인 바둑대회';
  if (/(?:대회|선수권)/u.test(raw)) return standaloneEventTitle({ title: raw }) || raw;
  if (/신진서/u.test(context) && /카타고/u.test(context)) {
    const hasResult = /(?:격파|꺾|승리|우승|완승|2승)/u.test(context);
    return hasResult ? '신진서 카타고 AI 격파' : '신진서 카타고전 전략';
  }
  if (/장윤기/u.test(context) && SERIOUS_CASE_WORDS.test(context)) return '장윤기 여고생 납치·살해 사건';
  return raw;
}

function buildListing(articles) {
  const personHints = repeatedPersonHints(articles);
  return articles.map((item, index) => {
    const date = String(item.published_at || item.fetched_at || '').slice(0, 10);
    const category = String(item.category || '').trim();
    const people = personHints[index].length ? `[인물:${personHints[index].join(',')}] ` : '';
    const summary = String(item.summary || '').replace(/\n/g, ' ').slice(0, 45);
    return `${index}. [${date}${category ? `·${category}` : ''}] ${people}${item.title}${summary ? ` — ${summary}` : ''}`;
  }).join('\n');
}

function buildPrompt(newArticles, existingIssues) {
  const existingBlock = existingIssues.length
    ? `기존 이슈 목록:\n${existingIssues.map(issue => `- ${issue.title}${issue.context ? ` — ${issue.context}` : ''}`).join('\n')}\n\n`
    : '';
  return `${existingBlock}새 기사 목록:\n${buildListing(newArticles)}`;
}

const INCIDENT_WORDS = /(?:사망|숨져|숨진|사고|화재|폭발|붕괴|실종|피해)/u;
const DOWN_DIRECTION = /(?:급락|폭락|하락|약세|추락|감소|줄(?:었|어|인다|었다)|최저)/u;
const UP_DIRECTION = /(?:급등|상승|강세|반등|회복|증가|늘(?:었|어|린다|었다)|최고|전고점)/u;
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

export function hasIssueDirectionConflict(existingContext, article) {
  const existing = String(existingContext || '');
  const incoming = `${article?.title || ''} ${article?.summary || ''}`;
  const oldDown = DOWN_DIRECTION.test(existing), oldUp = UP_DIRECTION.test(existing);
  const newDown = DOWN_DIRECTION.test(incoming), newUp = UP_DIRECTION.test(incoming);
  if (oldDown && oldUp) return false;
  if (newDown && newUp) return false;
  return (oldDown && newUp) || (oldUp && newDown);
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
      const context = `${existing.title} ${existing.context}`;
      (hasIncidentLocationConflict(context, article) || hasIssueDirectionConflict(context, article) ? rejected : accepted).push(key);
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
      title: standaloneEventTitle(articles[index]) || '바둑 대회',
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
