import { buildSummary, normalizeText, stripNumbering, validateThreeLineSummary } from './news-summary.js';

function numbers(value) {
  return new Set((String(value || '').match(/\d+(?:[.,]\d+)*(?:%|원|명|건|년|월|일|시|분)?/g) || []).map(v => v.replace(/,/g, '')));
}

function numbersGrounded(summary, source) {
  const allowed = numbers(source);
  return [...numbers(summary)].every(value => allowed.has(value));
}

function normalizeAiAnswer(value) {
  const text = normalizeText(value)
    .replace(/```(?:json|text|markdown)?/gi, '')
    .replace(/<\|[^>]+\|>/g, '');
  const rawLines = text.split('\n').map(line => line.trim()).filter(Boolean);
  let selected = rawLines.filter(line => /^\s*(?:[1-3][.)]|[①②③])\s*/u.test(line));
  if (selected.length < 3) {
    selected = text.split(/(?<=다\.)\s+(?=(?:[1-3][.)]\s*)?[가-힣A-Z])/u).filter(Boolean);
  }
  const lines = selected.map(stripNumbering).map(line => line
    .replace(/^\*\*|\*\*$/g, '')
    .replace(/^(?:요약|핵심)\s*[:：]\s*/u, '')
    .trim()).filter(Boolean).slice(0, 3);
  return lines.map((line, index) => `${index + 1}) ${line}`).join('\n');
}

const ANTHROPIC_MODEL = 'claude-haiku-4-5-20251001';

async function runAnthropic(apiKey, instructions, title, source) {
  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01'
    },
    body: JSON.stringify({
      model: ANTHROPIC_MODEL,
      max_tokens: 420,
      temperature: 0,
      system: instructions,
      messages: [{ role: 'user', content: `제목: ${title}\n\n원문:\n${source}` }]
    })
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const message = payload?.error?.message || `Anthropic API ${response.status}`;
    throw new Error(message);
  }
  return {
    text: (payload?.content || []).filter(block => block?.type === 'text').map(block => block.text).join('\n'),
    usage: payload?.usage || {}
  };
}

export async function makeBestSummary(env, { title = '', rawSummary = '', body = '', category = '' } = {}, diagnostics = null) {
  const source = normalizeText(body || rawSummary).slice(0, 6000);
  if (!source) return '';

  const useAnthropic = env?.NEWSBRIEF_USE_ANTHROPIC === '1'
    && Boolean(env?.ANTHROPIC_API_KEY);
  if ((useAnthropic || env?.AI) && source.length >= 300) {
    if (diagnostics) diagnostics.ai_attempted = true;
    const instructions = `당신은 한국어 뉴스 편집자다. 제공된 원문에 명시된 사실만 사용해 정확히 3줄로 요약한다.

절대 규칙:
- 각 줄은 서로 다른 핵심 사실 하나만 담은 완전한 한국어 문장으로 쓴다.
- 각 줄은 25~120자이며 '~다.', '~했다.', '~밝혔다.' 같은 보도문 종결어미로 끝낸다.
- 제목을 그대로 반복하지 않는다.
- 추측, 평가, 배경지식, 원문에 없는 숫자·인물·기관을 만들지 않는다.
- 비유, 수사, 관전 포인트, 의미 부여, 전망, 감상은 쓰지 않는다.
- 기자명, 이메일, 송고시간, 광고, 구독, 제보, 추천기사, 관련기사, 포털 UI, 사진 설명을 넣지 않는다.
- 말줄임표와 문장 조각을 쓰지 않는다.
- 출력은 "1) 문장", "2) 문장", "3) 문장" 세 줄뿐이다.`;
    try {
      let answer = '';
      if (useAnthropic) {
        const result = await runAnthropic(env.ANTHROPIC_API_KEY, instructions, title, source);
        answer = result.text;
        if (diagnostics) Object.assign(diagnostics, {
          ai_provider: 'anthropic',
          ai_model: ANTHROPIC_MODEL,
          ai_input_tokens: Number(result.usage?.input_tokens || 0),
          ai_output_tokens: Number(result.usage?.output_tokens || 0)
        });
      } else {
        const result = await env.AI.run('@cf/meta/llama-4-scout-17b-16e-instruct', {
          messages: [
            { role: 'system', content: instructions },
            { role: 'user', content: `제목: ${title}\n\n원문:\n${source}` }
          ],
          max_tokens: 420,
          temperature: 0,
          top_p: 0.8
        });
        answer = result?.response || result?.result?.response || '';
        if (diagnostics) diagnostics.ai_provider = 'cloudflare';
      }
      const aiSummary = normalizeAiAnswer(answer);
      const structurallyValid = validateThreeLineSummary(aiSummary, title);
      const grounded = numbersGrounded(aiSummary, `${title}\n${source}`);
      if (diagnostics) Object.assign(diagnostics, {
        ai_returned: Boolean(answer),
        normalized: aiSummary.slice(0, 700),
        structurally_valid: structurallyValid,
        numbers_grounded: grounded
      });
      if (structurallyValid && grounded) return aiSummary;
    } catch (error) {
      if (diagnostics) diagnostics.ai_error = String(error?.message || error).slice(0, 300);
    }
  }

  const extractive = buildSummary({ title, rawSummary, body: source });
  return validateThreeLineSummary(extractive, title) ? extractive : '';
}
