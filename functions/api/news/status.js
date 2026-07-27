import { json } from '../../_lib/news-db.js';

export async function onRequestGet({ env }) {
  try {
    const [articles, run, categories, dates, badukRecovery] = await Promise.all([
      env.DB.prepare(`SELECT COUNT(*) AS count, MAX(fetched_at) AS latest,
        SUM(CASE WHEN length(body_text)>=300 THEN 1 ELSE 0 END) AS body_ready,
        SUM(CASE WHEN summary_quality='full' THEN 1 ELSE 0 END) AS publishable,
        SUM(CASE WHEN image_url<>'' THEN 1 ELSE 0 END) AS with_image
        FROM news_articles`).first(),
      env.DB.prepare('SELECT started_at,finished_at,status,inserted_count,message FROM news_runs ORDER BY id DESC LIMIT 1').first()
      ,env.DB.prepare(`SELECT category,COUNT(*) AS stored,
        SUM(CASE WHEN summary_quality='full' THEN 1 ELSE 0 END) AS publishable
        FROM news_articles WHERE datetime(COALESCE(NULLIF(published_at,''),fetched_at))>=datetime('now','-30 days') GROUP BY category`).all()
      ,env.DB.prepare(`SELECT substr(COALESCE(NULLIF(published_at,''),fetched_at),1,10) AS day,COUNT(*) AS stored,
        SUM(CASE WHEN summary_quality='full' THEN 1 ELSE 0 END) AS publishable
        FROM news_articles WHERE datetime(COALESCE(NULLIF(published_at,''),fetched_at))>=datetime('now','-30 days')
        GROUP BY day ORDER BY day DESC LIMIT 31`).all()
      ,env.DB.prepare(`SELECT
        COUNT(*) AS stored,
        SUM(CASE WHEN a.summary_quality='full' THEN 1 ELSE 0 END) AS summarized,
        SUM(CASE WHEN a.summary_quality='none' AND length(a.body_text)>=300 AND COALESCE(f.attempts,0)<24 THEN 1 ELSE 0 END) AS ai_retryable,
        SUM(CASE WHEN a.summary_quality='none' AND length(a.body_text)>=300 AND COALESCE(f.attempts,0)>=24 THEN 1 ELSE 0 END) AS ai_exhausted,
        SUM(CASE WHEN a.summary_quality='none' AND length(a.body_text)>=180 AND length(a.body_text)<300 THEN 1 ELSE 0 END) AS body_short,
        SUM(CASE WHEN a.summary_quality='none' AND length(a.body_text)<180 THEN 1 ELSE 0 END) AS body_missing,
        SUM(CASE WHEN a.title LIKE '%칼럼%' OR a.title LIKE '%사설%' OR a.title LIKE '%기고%'
          OR a.title LIKE '%시론%' OR a.title LIKE '%논단%' OR a.title LIKE '%오피니언%' THEN 1 ELSE 0 END) AS opinion
        FROM news_articles a LEFT JOIN news_summary_attempts f ON f.url_key=a.url_key
        WHERE a.category='바둑' AND datetime(COALESCE(NULLIF(a.published_at,''),a.fetched_at))>=datetime('now','-30 days')`).first()
    ]);
    return json({
      ok: true,
      article_count: articles?.count || 0,
      latest_article: articles?.latest || '',
      body_ready: articles?.body_ready || 0,
      publishable: articles?.publishable || 0,
      with_image: articles?.with_image || 0,
      ai_bound: Boolean(env.AI),
      categories: categories?.results || [],
      dates: dates?.results || [],
      baduk_recovery: badukRecovery || null,
      last_run: run || null
    });
  } catch (error) {
    return json({ ok: false, error: error.message }, 500);
  }
}
