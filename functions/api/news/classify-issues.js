import { ensureNewsDb, isCollectorAuthorized, json } from '../../_lib/news-db.js';
import { CONTENT_QUALITY_FILTERS } from './articles.js';
import { isSameIssueTitle } from '../../_lib/news-dedup.js';
import {
  classifyIssues, isStandaloneEventArticle, rejectConflictingExistingMatches,
  rewriteStandaloneTitles, standaloneIssueTitle
} from '../../_lib/news-issue-classify.js';
import {
  blockCloudflareForToday, canUseClaude, recordClaudeUsage, reserveClaudeSpend,
  reserveCloudflareCall, settleClaudeSpend
} from '../../_lib/news-ai-budget.js';

const SUPPORTED_CATEGORIES = new Set(['바둑', '일반']);
const ESTIMATED_ISSUE_CALL_MICRO_USD = 180_000;
// A handful of short headlines in one small prompt - a fraction of a full
// classification call's cost (see ESTIMATED_ISSUE_CALL_MICRO_USD above).
const ESTIMATED_TITLE_REWRITE_MICRO_USD = 20_000;

function loadExistingPayload(row) {
  if (!row) return [];
  try {
    const parsed = JSON.parse(row.payload);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export function buildClassificationPlan(articles, existingPayload, resetIssues = false) {
  const cachedKeys = new Set(existingPayload.flatMap(group => group.url_keys || []));
  const genuinelyNewArticles = resetIssues ? articles : articles.filter(article => !cachedKeys.has(article.url_key));
  // Do not send an ever-growing 30-day misc bucket back to the model every
  // day. It both wastes tokens and lets an unrelated old singleton get pulled
  // into a fresh issue. A recent bounded tail is enough to join reports that
  // arrived on adjacent collection runs.
  const recentMiscKeys = new Set(articles.slice(0, 80).map(article => article.url_key));
  const miscKeys = new Set(existingPayload
    .filter(group => group.misc || String(group.key || '').endsWith('|ai:misc'))
    .flatMap(group => group.url_keys || [])
    .filter(key => recentMiscKeys.has(key))
    .slice(0, 40));
  const candidateKeys = new Set(resetIssues
    ? articles.map(article => article.url_key)
    : [...genuinelyNewArticles.map(article => article.url_key), ...miscKeys]);
  return {
    genuinelyNewArticles,
    candidateKeys,
    candidateArticles: articles.filter(article => candidateKeys.has(article.url_key))
  };
}

export function enforceIssueRules(groups, articles, category) {
  const articleByKey = new Map(articles.map(article => [article.url_key, article]));
  const claimed = new Set();
  const mergedByTitle = new Map();
  const miscKeys = [];
  const orderedGroups = [...(groups || [])].sort((left, right) =>
    Number(Boolean(left?.misc || String(left?.key || '').endsWith('|ai:misc')))
    - Number(Boolean(right?.misc || String(right?.key || '').endsWith('|ai:misc'))));
  for (const group of orderedGroups) {
    const title = String(group?.title || '').trim().slice(0, 40);
    const keys = [...new Set(group?.url_keys || [])].filter(key => articleByKey.has(key) && !claimed.has(key));
    keys.forEach(key => claimed.add(key));
    if (!keys.length) continue;
    const isMisc = group?.misc || title === '기타' || String(group?.key || '').endsWith('|ai:misc');
    if (isMisc) {
      miscKeys.push(...keys);
      continue;
    }
    // 제목이 완전히 같을 때만 합치면 AI가 같은 대회에 이름을 다르게 붙인 이슈가
    // 그대로 남는다. 실측 2026-08-10: 'Sh수협은행 여자바둑최강전'과 'SH수협은행
    // 여자바둑대회'가 대소문자만 다른데 따로 있었다. 고유명사가 겹치면 합친다
    // (isSameIssueTitle). 부문이 다르면 합치지 않으므로 하찬석국수배 영재부와
    // 어린이부는 그대로 나뉜다.
    const existing = mergedByTitle.get(title)
      || [...mergedByTitle.values()].find(group => isSameIssueTitle(group.title, title));
    if (existing) existing.url_keys.push(...keys);
    else mergedByTitle.set(title, { ...group, title, url_keys: keys });
  }
  for (const key of articleByKey.keys()) if (!claimed.has(key)) miscKeys.push(key);

  const kept = [];
  for (const group of mergedByTitle.values()) {
    const standaloneEvent = group.url_keys.length === 1
      && isStandaloneEventArticle(articleByKey.get(group.url_keys[0]));
    if (group.url_keys.length >= 2 || standaloneEvent) kept.push(group);
    else miscKeys.push(...group.url_keys);
  }
  let uniqueMisc = [...new Set(miscKeys)].filter(key => !kept.some(group => group.url_keys.includes(key)));
  // Baduk: title names an official event. General: already ranks in portal
  // popularity data (see is_popular on the article row below). Either way,
  // isStandaloneEventArticle is the single source of truth for "worth its
  // own tile even alone" - see news-issue-classify.js.
  const missedStandalone = uniqueMisc.filter(key => isStandaloneEventArticle(articleByKey.get(key)));
  for (const key of missedStandalone) {
    const article = articleByKey.get(key);
    kept.push({
      key: `${category}|ai:event:${key.slice(0, 16)}`,
      title: standaloneIssueTitle(article) || (category === '바둑' ? '바둑 이슈' : '이슈'),
      url_keys: [key]
    });
  }
  const standaloneKeys = new Set(missedStandalone);
  uniqueMisc = uniqueMisc.filter(key => !standaloneKeys.has(key));
  if (uniqueMisc.length) kept.push({ key: `${category}|ai:misc`, title: '기타', url_keys: uniqueMisc, misc: true });
  return kept;
}

export async function onRequestPost({ request, env }) {
  if (!isCollectorAuthorized(request, env)) return json({ error: 'Unauthorized' }, 401);
  try {
    await ensureNewsDb(env);
    const url = new URL(request.url);
    const category = url.searchParams.get('category') || '바둑';
    const resetIssues = url.searchParams.get('reset') === '1';
    const rollbackIssues = url.searchParams.get('rollback') === '1';
    const forceFree = url.searchParams.get('free') === '1';
    const regroupIssues = url.searchParams.get('regroup') === '1';
    if (!SUPPORTED_CATEGORIES.has(category)) return json({ error: `지원하지 않는 category: ${category}` }, 400);
    if (rollbackIssues) {
      const previous = await env.DB.prepare(
        `SELECT payload,built_at FROM news_issue_cache_history WHERE category=? ORDER BY id DESC LIMIT 1`
      ).bind(category).first();
      if (!previous?.payload) return json({ ok: false, category, error: '복원할 이전 이슈 캐시가 없습니다.' }, 404);
      await env.DB.batch([
        env.DB.prepare(
          `INSERT INTO news_issue_cache_history (category,payload,built_at)
           SELECT category,payload,built_at FROM news_issue_cache WHERE category=?`
        ).bind(category),
        env.DB.prepare(
          `INSERT INTO news_issue_cache (category,payload,built_at) VALUES (?,?,CURRENT_TIMESTAMP)
           ON CONFLICT(category) DO UPDATE SET payload=excluded.payload,built_at=CURRENT_TIMESTAMP`
        ).bind(category, previous.payload)
      ]);
      return json({ ok: true, category, rolled_back: true, restored_built_at: previous.built_at });
    }

    const dbCategory = category === '바둑' ? '바둑' : null;
    const where = [...CONTENT_QUALITY_FILTERS, "datetime(COALESCE(NULLIF(a.published_at,''),a.fetched_at)) >= datetime('now','-30 days')"];
    const bindings = [];
    if (dbCategory) {
      // 바둑 탭은 분류가 사회여도 바둑 독자에게 소식인 기사를 함께 싣는다
      // (articles.js의 같은 조건). 분류기가 category='바둑'만 보면 그 기사들은
      // 이슈 캐시에 아예 없어서 카드로는 떠도 이슈 키워드가 안 만들어지고
      // 기타로 빠진다. 실측 2026-08-10: 노원구 기원 살인 보도 8건이 바둑 탭에
      // 카드로는 있는데 주간·월간 이슈 키워드에는 없었다. 읽기와 같은 조건을 건다.
      where.push(`(a.category = ? OR a.title LIKE '%바둑%'
        OR (a.title LIKE '%기원%' AND a.summary LIKE '%바둑%'))`);
      bindings.push(dbCategory);
    } else if (category === '일반') {
      where.push("a.category NOT IN ('바둑','IT/과학')");
    }
    bindings.push(400);

    const [result, cacheRow] = await Promise.all([
      // is_popular used to match ANY historical popularity-table hit, so almost
      // every general article eventually qualified as a standalone 1-article
      // issue. Scope it to this week's true top 12 (by best portal rank) so the
      // gate is rare again, the way it was meant to be.
      env.DB.prepare(`
        WITH ranked_popularity AS (
          SELECT url_key AS match_key, MIN(rank) AS best_rank, MAX(collected_at) AS seen_at
          FROM news_popularity
          WHERE datetime(collected_at) >= datetime('now','-7 days')
          GROUP BY url_key
          UNION ALL
          SELECT title AS match_key, MIN(rank) AS best_rank, MAX(collected_at) AS seen_at
          FROM news_popular_items
          WHERE datetime(collected_at) >= datetime('now','-7 days')
          GROUP BY title
        ),
        top_popularity AS (
          SELECT match_key FROM ranked_popularity ORDER BY best_rank ASC, seen_at DESC LIMIT 12
        )
        SELECT a.url_key, a.title, a.summary, a.category, a.published_at, a.fetched_at,
               CASE WHEN EXISTS(SELECT 1 FROM top_popularity tp WHERE tp.match_key=a.url_key OR tp.match_key=a.title)
               THEN 1 ELSE 0 END AS is_popular
        FROM news_articles a
        WHERE ${where.join(' AND ')}
        ORDER BY datetime(COALESCE(NULLIF(a.published_at,''), a.fetched_at)) DESC
        LIMIT ?
      `).bind(...bindings).all(),
      env.DB.prepare('SELECT payload FROM news_issue_cache WHERE category=?').bind(category).first()
    ]);
    const articles = result.results || [];
    const inWindowKeys = new Set(articles.map(a => a.url_key));

    // Drop url_keys that aged out of the 30-day window (and any group that
    // becomes empty as a result) before deciding what's genuinely new.
    const standaloneEventKeys = new Set(articles.filter(isStandaloneEventArticle).map(article => article.url_key));
    const savedPayload = loadExistingPayload(cacheRow);
    const existingPayload = (resetIssues ? [] : savedPayload)
      .map(group => ({
        ...group,
        url_keys: (group.url_keys || []).filter(key => inWindowKeys.has(key)
          && !((group.misc || String(group.key || '').endsWith('|ai:misc'))
            && standaloneEventKeys.has(key)))
      }))
      .filter(group => group.url_keys.length > 0);

    // When new articles arrive, reconsider the current misc pool with them. This
    // lets two reports received on different days become an issue without paying
    // to reclassify established groups on every scheduled run.
    const { genuinelyNewArticles, candidateKeys, candidateArticles: newArticles } =
      buildClassificationPlan(articles, existingPayload, resetIssues || regroupIssues);

    if (!genuinelyNewArticles.length) {
      return json({
        ok: true,
        category,
        count: articles.length,
        new_count: 0,
        provider: 'none',
        issues: enforceIssueRules(existingPayload, articles, category).map(group => ({ key: group.key, title: group.title, count: group.url_keys.length }))
      });
    }

    const budget = await canUseClaude(env, ESTIMATED_ISSUE_CALL_MICRO_USD);
    const useClaude = !forceFree && budget.allowed && Boolean(env?.ANTHROPIC_API_KEY);
    let cloudflare = { allowed: false, used: 0, reason: 'claude-primary' };
    if (!useClaude) cloudflare = await reserveCloudflareCall(env);
    if (!cloudflare.allowed && !useClaude) return json({
      ok: true, category, count: articles.length, new_count: genuinelyNewArticles.length,
      provider: 'budget-blocked', monthly_micro_usd: budget.spent,
      issues: enforceIssueRules(existingPayload, articles, category).map(group => ({ key: group.key, title: group.title, count: group.url_keys.length }))
    });

    const basePayload = (regroupIssues ? [] : existingPayload)
      .map(group => ({ ...group, url_keys: group.url_keys.filter(key => !candidateKeys.has(key)) }))
      .filter(group => group.url_keys.length > 0);
    const articleByKey = new Map(articles.map(article => [article.url_key, article]));
    const existingIssues = (regroupIssues ? existingPayload : basePayload)
      .filter(group => !(group.misc || String(group.key || '').endsWith('|ai:misc')))
      .map(group => {
        const representatives = (group.url_keys || []).slice(0, 2).map(key => articleByKey.get(key)).filter(Boolean);
        return {
          key: group.key,
          title: group.title,
          context: representatives.map(item => `${item.title} ${String(item.summary || '').replace(/\n/g, ' ').slice(0, 120)}`).join(' / ')
        };
      });
    // 호출 전에 예상 비용을 먼저 적는다. recordClaudeUsage는 호출이 끝난 뒤에만
    // 도는데, 응답을 돌려주지 못하고 죽은 실행은 돈을 쓰고도 기록에 안 남았다.
    // 2026-08-10 실측: 재분류가 실제 $0.91을 썼는데 예산에는 $0.041만 잡혔다.
    const reserved = useClaude ? await reserveClaudeSpend(env, ESTIMATED_ISSUE_CALL_MICRO_USD) : 0;
    let classification = await classifyIssues(
      {
        ...env,
        AI: useClaude ? undefined : (cloudflare.allowed ? env.AI : undefined),
        ANTHROPIC_API_KEY: useClaude ? env.ANTHROPIC_API_KEY : undefined
      },
      newArticles,
      existingIssues,
      // 항상 Haiku로 돈다. 예전에는 reset/regroup이 정확도 옵션을 켜 Sonnet으로
      // 수동 재분류 한 번이 Sonnet(입력 $3 / 출력 $15 per M, max_tokens 16000)으로
      // 돌았다. 2026-08-10 실측: 재분류 두 번에 실제 $0.91을 썼는데 예산에는
      // $0.041만 기록됐다. 월 목표가 $4.75인 프로젝트에서 한 번에 5분의 1이다.
      // 정확도가 정말 필요하면 그때 별도 입력으로 되살리되 기본값은 끈다.
      { allowStandaloneEvents: category === '바둑' }
    );
    if (classification.provider === 'anthropic-failed' && env?.AI) {
      cloudflare = await reserveCloudflareCall(env);
      if (cloudflare.allowed) {
        const fallback = await classifyIssues(
          { ...env, ANTHROPIC_API_KEY: undefined, AI: env.AI },
          newArticles,
          existingIssues,
          { allowStandaloneEvents: category === '바둑' }
        );
        classification = { ...fallback, anthropic_error: classification.anthropic_error };
      }
    }
    const { provider, model, usage, cloudflare_error, anthropic_error } = classification;
    // AI가 뭘 돌려줬고 우리가 뭘 버렸는지 남긴다. 이게 없으면 이슈가 안 생겼을 때
    // AI 탓인지 후처리 탓인지 구분할 수 없다(2026-08-10 기원 살인 보도 8건).
    const ruleRejections = {};
    const aiGroups = (classification.groups || []).map(group => ({
      title: String(group?.title || '').slice(0, 40),
      count: (group?.url_keys || []).length,
      misc: Boolean(group?.misc)
    }));
    const groups = rejectConflictingExistingMatches(classification.groups, newArticles, existingIssues, ruleRejections);
    if (cloudflare_error && /(?:daily free allocation|Account limited|3036|4006)/i.test(cloudflare_error)) {
      await blockCloudflareForToday(env);
    }
    // 미리 적어 둔 예상치를 실제 비용으로 정산한다. Claude를 안 썼으면 예약분을
    // 그대로 되돌린다(usage 없이 정산하면 실제 0으로 계산돼 예약분이 빠진다).
    const recorded = reserved
      ? await settleClaudeSpend(env, reserved, provider === 'anthropic' ? model : '', usage)
      : (provider === 'anthropic' ? await recordClaudeUsage(env, model, usage) : { cost: 0, spent: budget.spent });

    if (!groups.length) return json({
      ok: true, category, count: articles.length, new_count: genuinelyNewArticles.length,
      provider, cloudflare_error, anthropic_error, monthly_micro_usd: budget.spent,
      ai_groups: aiGroups, rule_rejections: ruleRejections,
      // A reset starts with an empty working set, but an AI parse/provider
      // failure must never replace the last good cache with one giant misc
      // bucket. Preserve the saved payload until a valid grouping exists.
      issues: enforceIssueRules(savedPayload, articles, category).map(group => ({ key: group.key, title: group.title, count: group.url_keys.length }))
    });

    const byKey = new Map(basePayload.map(group => [group.key, { ...group, url_keys: [...group.url_keys] }]));
    let nextIndex = 0;

    for (const group of groups) {
      if (group.misc) {
        const miscKey = `${category}|ai:misc`;
        const existingMisc = byKey.get(miscKey);
        if (existingMisc) existingMisc.url_keys.push(...group.url_keys);
        else byKey.set(miscKey, { key: miscKey, title: '기타', url_keys: [...group.url_keys] });
        continue;
      }
      const matched = existingIssues.find(existing => existing.title === group.title);
      if (matched) {
        const existing = byKey.get(matched.key);
        if (existing) {
          existing.url_keys.push(...group.url_keys);
          if (group.main_key) existing.main_key = group.main_key;
        } else byKey.set(matched.key, {
          key: matched.key, title: matched.title, url_keys: [...group.url_keys],
          ...(group.main_key ? { main_key: group.main_key } : {})
        });
      } else {
        let key;
        do key = `${category}|ai:${nextIndex++}`; while (byKey.has(key));
        // main_key는 AI가 고른 대표 기사다. 화면이 카드 제목을 정할 때 쓴다.
        byKey.set(key, {
          key, title: group.title, url_keys: [...group.url_keys],
          ...(group.main_key ? { main_key: group.main_key } : {})
        });
      }
    }

    const payload = enforceIssueRules([...byKey.values()], articles, category);

    // Standalone general tiles never pass through the main clustering prompt
    // (no peer article to justify a crafted title), so they otherwise show
    // the raw scraped headline. One small follow-up call rewrites just those
    // - bounded by the top-12 popularity gate, so this stays cheap even when
    // the full category is too large to reclassify synchronously.
    let titleRewriteCost = 0;
    let monthlySpent = recorded.spent;
    if (category === '일반' && !forceFree && env?.ANTHROPIC_API_KEY) {
      const standaloneGroups = payload.filter(group =>
        !group.misc && !group.key.endsWith('|ai:misc') && group.url_keys.length === 1);
      if (standaloneGroups.length) {
        const titleBudget = await canUseClaude(env, ESTIMATED_TITLE_REWRITE_MICRO_USD);
        if (titleBudget.allowed) {
          const standaloneArticles = standaloneGroups.map(group => articleByKey.get(group.url_keys[0])).filter(Boolean);
          const { titles, usage: titleUsage } = await rewriteStandaloneTitles(env, standaloneArticles);
          for (const group of standaloneGroups) {
            const rewritten = titles.get(group.url_keys[0]);
            if (rewritten) group.title = rewritten;
          }
          if (titles.size) {
            const titleRecorded = await recordClaudeUsage(env, 'claude-haiku-4-5-20251001', titleUsage);
            titleRewriteCost = titleRecorded.cost || 0;
            monthlySpent = titleRecorded.spent;
          }
        }
      }
    }

    const previousCache = cacheRow?.payload ? loadExistingPayload(cacheRow) : [];
    const writes = [];
    if (previousCache.length) {
      writes.push(env.DB.prepare(
        `INSERT INTO news_issue_cache_history (category,payload,built_at)
         SELECT category,payload,built_at FROM news_issue_cache WHERE category=?`
      ).bind(category));
    }
    writes.push(env.DB.prepare(
      `INSERT INTO news_issue_cache (category, payload, built_at) VALUES (?, ?, CURRENT_TIMESTAMP)
       ON CONFLICT(category) DO UPDATE SET payload = excluded.payload, built_at = CURRENT_TIMESTAMP`
    ).bind(category, JSON.stringify(payload)));
    await env.DB.batch(writes);

    return json({
      ok: true,
      category,
      count: articles.length,
      new_count: genuinelyNewArticles.length,
      candidate_count: newArticles.length,
      // AI가 돌려준 묶음과 우리가 규칙으로 버린 건수. 이슈가 안 생겼을 때
      // AI 탓인지 후처리 탓인지 이 두 값으로 갈린다.
      ai_groups: aiGroups,
      rule_rejections: ruleRejections,
      provider,
      cloudflare_calls_today: cloudflare.used,
      cloudflare_error,
      anthropic_error,
      usage,
      cost_micro_usd: recorded.cost + titleRewriteCost,
      monthly_micro_usd: monthlySpent,
      issues: payload.map(group => ({ key: group.key, title: group.title, count: group.url_keys.length }))
    });
  } catch (error) {
    return json({ ok: false, error: error.message }, 500);
  }
}
