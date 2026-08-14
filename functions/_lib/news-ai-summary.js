import { buildSummary, normalizeText, stripNumbering, summaryRejectionReason, validateThreeLineSummary } from './news-summary.js';

function numbers(value) {
  return new Set((String(value || '').match(/\d+(?:[.,]\d+)*(?:%|원|명|건|년|월|일|시|분)?/g) || []).map(v => v.replace(/,/g, '')));
}

// 요약에 원문에 없는 숫자가 섞였는지 본다. 반드시 **번호 매김을 뗀 뒤에** 세야
// 한다. 예전에는 "1) …\n2) …\n3) …" 전체를 그대로 넣어서 줄 번호 1·2·3이 기사
// 숫자로 세어졌다. 원문에 2나 3이 안 나오는 기사면 아무리 정확한 요약이라도
// 무조건 탈락한다 - 짧은 기사일수록 그렇다.
//
// 2026-08-14 실측으로 이것 때문에 버려진 요약들:
//   "1) 신진서 9단이 8월 한국 바둑랭킹에서 1위를 차지하며 80개월 연속으로 정상의
//    자리를 지켰다."            (원문 숫자: 11일 6 9 14일 8월 1 80 - 2와 3이 없다)
//   "1) GS칼텍스배 프로기전에서 김정현 9단이 신민준 9단을 꺾고 4강에 진출했다."
// 전부 정확한 요약인데 줄 번호 때문에 죽었다. 그날 24시간 바둑 화면이 0건이었다.
export function numbersGrounded(summary, source) {
  const allowed = numbers(source);
  const body = String(summary || '').split('\n').map(stripNumbering).join('\n');
  return [...numbers(body)].every(value => allowed.has(value));
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
  // 원문을 앞에서 2500자만 보낸다. Haiku 요금은 입력 $1 / 출력 $5(per 1M)라
  // 3줄 요약 한 건의 비용은 대부분 입력 토큰에서 나오는데, 한국어 기사는
  // 핵심 사실이 리드와 앞 문단에 몰려 있고 뒤쪽은 기자 이메일·저작권·관련기사
  // 같은 요약에 쓸 수 없는 꼬리가 차지한다. 6000자를 보내던 시절에는 그 꼬리까지
  // 매번 토큰으로 지불하면서 월 예산을 열흘 만에 태웠다.
  const source = normalizeText(body || rawSummary).slice(0, 2500);
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
        numbers_grounded: grounded,
        // AI가 답을 줬는데 우리가 버렸다면 **어느 규칙이** 버렸는지 남긴다.
        // 이게 없으면 "AI가 요약을 못 한다"와 "우리 검사가 과하다"를 구분할 수
        // 없다 - 2026-08-14에 정확히 그걸 몰라서 헤맸다. 검사를 조인 그날
        // 바둑 8건이 통째로 빈 값이 됐는데, 원인이 AI인지 검사인지 알 방법이
        // 진단 어디에도 없었다.
        ai_reject_rule: structurallyValid ? (grounded ? '' : 'numbers_not_grounded')
          : (summaryRejectionReason(aiSummary, title, '바둑') || 'three_line_checks'),
        ai_first_line: aiSummary.split('\n')[0]?.slice(0, 90) || ''
      });
      if (structurallyValid && grounded) return aiSummary;
    } catch (error) {
      if (diagnostics) diagnostics.ai_error = String(error?.message || error).slice(0, 300);
    }
  }

  const extractive = buildSummary({ title, rawSummary, body: source });
  return validateThreeLineSummary(extractive, title) ? extractive : '';
}
