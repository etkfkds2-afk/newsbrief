import { ensureNewsDb, isCollectorAuthorized, json } from '../../_lib/news-db.js';
import { CONTENT_QUALITY_FILTERS } from './articles.js';
import { classifyIssues } from '../../_lib/news-issue-classify.js';
import {
  blockCloudflareForToday, canUseClaude, recordClaudeUsage, reserveCloudflareCall
} from '../../_lib/news-ai-budget.js';

const SUPPORTED_CATEGORIES = new Set(['바둑', '일반']);
const MAX_NEW_ARTICLES_PER_RUN = 40;
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

export async function onRequestPost({ request, env }) {
  if (!isCollectorAuthorized(request, env)) return json({ error: 'Unauthorized' }, 401);
  try {
    await ensureNewsDb(env);
    const url = new URL(request.url);
    const category = url.searchParams.get('category') || '바둑';
    if (!SUPPORTED_CATEGORIES.has(category)) return json({ error: `지원하지 않는 category: ${category}` }, 400);

    const dbCategory = category === '바둑' ? '바둑' : null;
    const where = [...CONTENT_QUALITY_FILTERS, "datetime(COALESCE(NULLIF(a.published_at,''),a.fetched_at)) >= datetime('now','-30 days')"];
    const bindings = [];
    if (dbCategory) {
      where.push('a.category = ?');
      bindings.push(dbCategory);
    } else if (category === '일반') {
      where.push("a.category <> '바둑'");
    }
    bindings.push(400);

    const [result, cacheRow] = await Promise.all([
      env.DB.prepare(`
        SELECT a.url_key, a.title, a.summary, a.published_at, a.fetched_at
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
    const existingPayload = loadExistingPayload(cacheRow)
      .map(group => ({ ...group, url_keys: (group.url_keys || []).filter(key => inWindowKeys.has(key)) }))
      .filter(group => group.url_keys.length > 0);

    const classifiedKeys = new Set(existingPayload.flatMap(group => group.url_keys));
    const newArticles = articles.filter(a => !classifiedKeys.has(a.url_key)).slice(0, MAX_NEW_ARTICLES_PER_RUN);

    if (!newArticles.length) {
      return json({
        ok: true,
        category,
        count: articles.length,
        new_count: 0,
        provider: 'none',
        issues: existingPayload.map(group => ({ key: group.key, title: group.title, count: group.url_keys.length }))
      });
    }

    const [cloudflare, budget] = await Promise.all([
      reserveCloudflareCall(env),
      canUseClaude(env, ESTIMATED_ISSUE_CALL_MICRO_USD)
    ]);
    if (!cloudflare.allowed && !budget.allowed) return json({
      ok: true, category, count: articles.length, new_count: newArticles.length,
      provider: 'budget-blocked', monthly_micro_usd: budget.spent,
      issues: existingPayload.map(group => ({ key: group.key, title: group.title, count: group.url_keys.length }))
    });

    const existingIssues = existingPayload.filter(group => !group.misc && !String(group.key || '').endsWith('|ai:misc'));
    const { groups, provider, model, usage, cloudflare_error } = await classifyIssues(
      {
        ...env,
        AI: cloudflare.allowed ? env.AI : undefined,
        ANTHROPIC_API_KEY: budget.allowed ? env.ANTHROPIC_API_KEY : undefined
      },
      newArticles,
      existingIssues.map(group => ({ key: group.key, title: group.title }))
    );
    if (cloudflare_error && /(?:daily free allocation|Account limited|3036|4006)/i.test(cloudflare_error)) {
      await blockCloudflareForToday(env);
    }
    const recorded = provider === 'anthropic' ? await recordClaudeUsage(env, model, usage) : { cost: 0, spent: budget.spent };

    if (!groups.length && provider === 'cloudflare-failed') return json({
      ok: true, category, count: articles.length, new_count: newArticles.length,
      provider, cloudflare_error, monthly_micro_usd: budget.spent,
      issues: existingPayload.map(group => ({ key: group.key, title: group.title, count: group.url_keys.length }))
    });

    const byKey = new Map(existingPayload.map(group => [group.key, group]));
    let nextIndex = existingPayload.reduce((max, group) => {
      const match = /\|ai:(\d+)$/.exec(group.key || '');
      return match ? Math.max(max, Number(match[1]) + 1) : max;
    }, 0);

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
        matched.url_keys.push(...group.url_keys);
      } else {
        const key = `${category}|ai:${nextIndex++}`;
        byKey.set(key, { key, title: group.title, url_keys: [...group.url_keys] });
      }
    }

    const payload = [...byKey.values()];
    await env.DB.prepare(
      `INSERT INTO news_issue_cache (category, payload, built_at) VALUES (?, ?, CURRENT_TIMESTAMP)
       ON CONFLICT(category) DO UPDATE SET payload = excluded.payload, built_at = CURRENT_TIMESTAMP`
    ).bind(category, JSON.stringify(payload)).run();

    return json({
      ok: true,
      category,
      count: articles.length,
      new_count: newArticles.length,
      provider,
      cloudflare_calls_today: cloudflare.used,
      cloudflare_error,
      usage,
      cost_micro_usd: recorded.cost,
      monthly_micro_usd: recorded.spent,
      issues: payload.map(group => ({ key: group.key, title: group.title, count: group.url_keys.length }))
    });
  } catch (error) {
    return json({ ok: false, error: error.message }, 500);
  }
}
