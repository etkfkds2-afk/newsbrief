import { ensureNewsDb, isCollectorAuthorized, json } from '../../_lib/news-db.js';
import { CONTENT_QUALITY_FILTERS } from './articles.js';
import {
  classifyIssues, isStandaloneEventArticle, mergeRepeatedPersonCases,
  normalizeIssueTitle, rejectConflictingExistingMatches, standaloneEventTitle
} from '../../_lib/news-issue-classify.js';
import {
  blockCloudflareForToday, canUseClaude, recordClaudeUsage, reserveCloudflareCall
} from '../../_lib/news-ai-budget.js';

const SUPPORTED_CATEGORIES = new Set(['바둑', '일반']);
const ESTIMATED_ISSUE_CALL_MICRO_USD = 180_000;

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
  const miscKeys = new Set(existingPayload
    .filter(group => group.misc || String(group.key || '').endsWith('|ai:misc'))
    .flatMap(group => group.url_keys || []));
  const candidateKeys = new Set(resetIssues
    ? articles.map(article => article.url_key)
    : [...genuinelyNewArticles.map(article => article.url_key), ...miscKeys]);
  return {
    genuinelyNewArticles,
    candidateKeys,
    candidateArticles: articles.filter(article => candidateKeys.has(article.url_key))
  };
}

function tournamentStem(title) {
  return String(title || '')
    .replace(/제\s*\d+\s*회|20\d{2}|전국|바둑|선수권|대회/gu, '')
    .replace(/[\s·-]/g, '')
    .replace(/배$/u, '');
}

function groupDateRange(group, articleByKey) {
  const times = group.url_keys.map(key => Date.parse(articleByKey.get(key)?.published_at || articleByKey.get(key)?.fetched_at || '')).filter(Number.isFinite);
  return times.length ? [Math.min(...times), Math.max(...times)] : [NaN, NaN];
}

export function mergeTournamentAliasGroups(groups, articleByKey) {
  const merged = groups.map(group => ({ ...group, url_keys: [...group.url_keys] }));
  for (let index = 0; index < merged.length; index += 1) {
    const target = merged[index];
    if (!isStandaloneEventArticle({ title: target.title })) continue;
    for (let otherIndex = merged.length - 1; otherIndex > index; otherIndex -= 1) {
      const other = merged[otherIndex];
      if (!isStandaloneEventArticle({ title: other.title })) continue;
      const left = tournamentStem(target.title), right = tournamentStem(other.title);
      const shorter = left.length <= right.length ? left : right;
      const longer = left.length <= right.length ? right : left;
      if (shorter.length < 2 || !longer.startsWith(shorter)) continue;
      const [leftMin, leftMax] = groupDateRange(target, articleByKey);
      const [rightMin, rightMax] = groupDateRange(other, articleByKey);
      const dateGap = Math.min(Math.abs(leftMin - rightMax), Math.abs(rightMin - leftMax));
      if (Number.isFinite(dateGap) && dateGap > 3 * 86400000) continue;
      target.url_keys = [...new Set([...target.url_keys, ...other.url_keys])];
      if (right.length > left.length) target.title = other.title;
      merged.splice(otherIndex, 1);
    }
  }
  return merged;
}

export function enforceIssueRules(groups, articles, category) {
  const articleByKey = new Map(articles.map(article => [article.url_key, article]));
  const forcedTournamentByTitle = new Map();
  if (category === '바둑') {
    for (const article of articles) {
      const eventTitle = standaloneEventTitle(article);
      if (!eventTitle) continue;
      const existing = forcedTournamentByTitle.get(eventTitle);
      if (existing) existing.url_keys.push(article.url_key);
      else forcedTournamentByTitle.set(eventTitle, {
        key: `${category}|ai:event:${article.url_key.slice(0, 16)}`,
        title: eventTitle,
        url_keys: [article.url_key]
      });
    }
  }
  const forcedTournamentKeys = new Set([...forcedTournamentByTitle.values()].flatMap(group => group.url_keys));
  const claimed = new Set(forcedTournamentKeys);
  const mergedByTitle = new Map();
  const miscKeys = [];
  const orderedGroups = [...(groups || [])].sort((left, right) =>
    Number(Boolean(left?.misc || String(left?.key || '').endsWith('|ai:misc')))
    - Number(Boolean(right?.misc || String(right?.key || '').endsWith('|ai:misc'))));
  for (const group of orderedGroups) {
    const keys = [...new Set(group?.url_keys || [])].filter(key => articleByKey.has(key) && !claimed.has(key));
    const title = normalizeIssueTitle(group?.title, keys.map(key => articleByKey.get(key)));
    keys.forEach(key => claimed.add(key));
    if (!keys.length) continue;
    const isMisc = group?.misc || title === '기타' || String(group?.key || '').endsWith('|ai:misc');
    if (isMisc) {
      miscKeys.push(...keys);
      continue;
    }
    const existing = mergedByTitle.get(title);
    if (existing) existing.url_keys.push(...keys);
    else mergedByTitle.set(title, { ...group, title, url_keys: keys });
  }
  for (const key of articleByKey.keys()) if (!claimed.has(key)) miscKeys.push(key);

  const kept = [];
  const distinctGroups = category === '바둑'
    ? mergeTournamentAliasGroups([...mergedByTitle.values(), ...forcedTournamentByTitle.values()], articleByKey)
    : [...mergedByTitle.values()];
  for (const group of distinctGroups) {
    const standaloneTournament = category === '바둑' && group.url_keys.length === 1
      && isStandaloneEventArticle(articleByKey.get(group.url_keys[0]));
    if (group.url_keys.length >= 2 || standaloneTournament) kept.push(group);
    else miscKeys.push(...group.url_keys);
  }
  let uniqueMisc = [...new Set(miscKeys)].filter(key => !kept.some(group => group.url_keys.includes(key)));
  if (category === '바둑') {
    const missedTournaments = uniqueMisc.filter(key => isStandaloneEventArticle(articleByKey.get(key)));
    for (const key of missedTournaments) {
      const article = articleByKey.get(key);
      kept.push({
        key: `${category}|ai:event:${key.slice(0, 16)}`,
        title: standaloneEventTitle(article) || '바둑대회',
        url_keys: [key]
      });
    }
    const tournamentKeys = new Set(missedTournaments);
    uniqueMisc = uniqueMisc.filter(key => !tournamentKeys.has(key));
  }
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
    if (!SUPPORTED_CATEGORIES.has(category)) return json({ error: `지원하지 않는 category: ${category}` }, 400);

    const dbCategory = category === '바둑' ? '바둑' : null;
    const where = [...CONTENT_QUALITY_FILTERS, "datetime(COALESCE(NULLIF(a.published_at,''),a.fetched_at)) >= datetime('now','-30 days')"];
    const bindings = [];
    if (dbCategory) {
      where.push('a.category = ?');
      bindings.push(dbCategory);
    } else if (category === '일반') {
      where.push("a.category NOT IN ('바둑','IT/과학')");
    }
    bindings.push(400);

    const [result, cacheRow] = await Promise.all([
      env.DB.prepare(`
        SELECT a.url_key, a.title, a.summary, a.category, a.published_at, a.fetched_at
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
    const existingPayload = (resetIssues ? [] : loadExistingPayload(cacheRow))
      .map(group => ({
        ...group,
        url_keys: (group.url_keys || []).filter(key => inWindowKeys.has(key)
          && !((group.misc || String(group.key || '').endsWith('|ai:misc'))
            && category === '바둑' && standaloneEventKeys.has(key)))
      }))
      .filter(group => group.url_keys.length > 0);

    // When new articles arrive, reconsider the current misc pool with them. This
    // lets two reports received on different days become an issue without paying
    // to reclassify established groups on every scheduled run.
    const { genuinelyNewArticles, candidateKeys, candidateArticles: newArticles } =
      buildClassificationPlan(articles, existingPayload, resetIssues);

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
    const useClaude = budget.allowed && Boolean(env?.ANTHROPIC_API_KEY);
    let cloudflare = { allowed: false, used: 0, reason: 'claude-primary' };
    if (!useClaude) cloudflare = await reserveCloudflareCall(env);
    if (!cloudflare.allowed && !useClaude) return json({
      ok: true, category, count: articles.length, new_count: genuinelyNewArticles.length,
      provider: 'budget-blocked', monthly_micro_usd: budget.spent,
      issues: enforceIssueRules(existingPayload, articles, category).map(group => ({ key: group.key, title: group.title, count: group.url_keys.length }))
    });

    const basePayload = existingPayload
      .map(group => ({ ...group, url_keys: group.url_keys.filter(key => !candidateKeys.has(key)) }))
      .filter(group => group.url_keys.length > 0);
    const articleByKey = new Map(articles.map(article => [article.url_key, article]));
    const existingIssues = basePayload
      .filter(group => !(group.misc || String(group.key || '').endsWith('|ai:misc')))
      .map(group => {
        const representatives = (group.url_keys || []).slice(0, 2).map(key => articleByKey.get(key)).filter(Boolean);
        return {
          key: group.key,
          title: group.title,
          context: representatives.map(item => `${item.title} ${String(item.summary || '').replace(/\n/g, ' ').slice(0, 120)}`).join(' / ')
        };
      });
    let classification = await classifyIssues(
      {
        ...env,
        AI: useClaude ? undefined : (cloudflare.allowed ? env.AI : undefined),
        ANTHROPIC_API_KEY: useClaude ? env.ANTHROPIC_API_KEY : undefined
      },
      newArticles,
      existingIssues,
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
    const personCaseRecovered = mergeRepeatedPersonCases(classification.groups, newArticles);
    const groups = rejectConflictingExistingMatches(personCaseRecovered, newArticles, existingIssues);
    if (cloudflare_error && /(?:daily free allocation|Account limited|3036|4006)/i.test(cloudflare_error)) {
      await blockCloudflareForToday(env);
    }
    const recorded = provider === 'anthropic' ? await recordClaudeUsage(env, model, usage) : { cost: 0, spent: budget.spent };

    if (!groups.length) return json({
      ok: true, category, count: articles.length, new_count: genuinelyNewArticles.length,
      provider, cloudflare_error, anthropic_error, monthly_micro_usd: budget.spent,
      issues: enforceIssueRules(existingPayload, articles, category).map(group => ({ key: group.key, title: group.title, count: group.url_keys.length }))
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
        byKey.get(matched.key)?.url_keys.push(...group.url_keys);
      } else {
        let key;
        do key = `${category}|ai:${nextIndex++}`; while (byKey.has(key));
        byKey.set(key, { key, title: group.title, url_keys: [...group.url_keys] });
      }
    }

    const payload = enforceIssueRules([...byKey.values()], articles, category);
    await env.DB.prepare(
      `INSERT INTO news_issue_cache (category, payload, built_at) VALUES (?, ?, CURRENT_TIMESTAMP)
       ON CONFLICT(category) DO UPDATE SET payload = excluded.payload, built_at = CURRENT_TIMESTAMP`
    ).bind(category, JSON.stringify(payload)).run();

    return json({
      ok: true,
      category,
      count: articles.length,
      new_count: genuinelyNewArticles.length,
      candidate_count: newArticles.length,
      provider,
      cloudflare_calls_today: cloudflare.used,
      cloudflare_error,
      anthropic_error,
      usage,
      cost_micro_usd: recorded.cost,
      monthly_micro_usd: recorded.spent,
      issues: payload.map(group => ({ key: group.key, title: group.title, count: group.url_keys.length }))
    });
  } catch (error) {
    return json({ ok: false, error: error.message }, 500);
  }
}
