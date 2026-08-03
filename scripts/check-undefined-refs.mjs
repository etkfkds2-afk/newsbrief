// 모듈이 정의하지도 import 하지도 않은 식별자를 "호출"하는지 정적으로 찾는다.
// node --check는 문법만 보므로 리팩토링 중 생긴 참조 누락을 잡지 못한다.
// (titleIsTruncationOf가 정확히 이 경우로 운영에서 500을 냈다.)
import { readFileSync, readdirSync, statSync } from 'node:fs';

const GLOBALS = new Set(['console','JSON','Math','Date','Number','String','Boolean','Object','Array','Set','Map',
  'Promise','RegExp','Error','fetch','URL','URLSearchParams','TextDecoder','TextEncoder','crypto','btoa','atob',
  'setTimeout','clearTimeout','AbortController','Response','Request','Headers','isNaN','parseInt','parseFloat',
  'encodeURIComponent','decodeURIComponent','Infinity','NaN','undefined','globalThis','process','structuredClone',
  'Uint8Array','Int8Array','Float64Array','BigInt','Symbol','WeakMap','WeakSet','Proxy','Reflect','queueMicrotask']);
const KEYWORDS = new Set(['if','for','while','switch','catch','return','typeof','await','function','new','of','in',
  'do','else','try','throw','delete','void','instanceof','yield','case','import','export','async','super','this']);

// 주석과 문자열/템플릿 리터럴을 공백으로 치환해 SQL·산문 오탐을 없앤다.
function stripLiterals(src) {
  let out = '', i = 0;
  const isEsc = p => { let n = 0, k = p - 1; while (k >= 0 && src[k] === '\\') { n += 1; k -= 1; } return n % 2 === 1; };
  while (i < src.length) {
    const c = src[i], next = src[i + 1];
    if (c === '/' && next === '/') { while (i < src.length && src[i] !== '\n') { out += ' '; i += 1; } continue; }
    if (c === '/' && next === '*') { const e = src.indexOf('*/', i + 2); const end = e < 0 ? src.length : e + 2; out += ' '.repeat(end - i); i = end; continue; }
    if (c === '"' || c === "'" || c === '`') {
      const quote = c; out += ' '; i += 1;
      while (i < src.length && !(src[i] === quote && !isEsc(i))) { out += src[i] === '\n' ? '\n' : ' '; i += 1; }
      out += ' '; i += 1; continue;
    }
    // 정규식 리터럴: 앞 토큰이 값이 아닐 때만
    if (c === '/') {
      const prev = out.replace(/\s+$/, '').slice(-1);
      if (!prev || '(,=:[!&|?{};+-*%~^<>'.includes(prev)) {
        out += ' '; i += 1;
        while (i < src.length && !(src[i] === '/' && !isEsc(i))) { if (src[i] === '\n') break; out += ' '; i += 1; }
        out += ' '; i += 1; continue;
      }
    }
    out += c; i += 1;
  }
  return out;
}

// 검사 대상을 인자로 받거나, 없으면 functions/ 전체를 훑는다.
export function sourceFiles(root = 'functions') {
  const out = [];
  const walk = dir => {
    for (const name of readdirSync(dir)) {
      const full = `${dir}/${name}`;
      if (statSync(full).isDirectory()) walk(full);
      else if (name.endsWith('.js')) out.push(full);
    }
  };
  walk(root);
  return out.sort();
}

// 파일 하나를 검사해 정의되지 않은 호출 식별자 목록을 돌려준다.
export function undefinedRefs(file) {
  const raw = readFileSync(file, 'utf8');
  const code = stripLiterals(raw);
  const declared = new Set([...GLOBALS]);
  for (const m of raw.matchAll(/^import\s+\{([^}]*)\}/gms))
    for (const n of m[1].split(',')) { const t = n.trim().split(/\s+as\s+/).pop()?.trim(); if (t) declared.add(t); }
  for (const m of raw.matchAll(/^import\s+(\w+)\s+from/gm)) declared.add(m[1]);
  for (const m of code.matchAll(/\b(?:function)\s+(\w+)/g)) declared.add(m[1]);
  for (const m of code.matchAll(/\b(?:const|let|var)\s+(\w+)/g)) declared.add(m[1]);
  for (const m of code.matchAll(/\b(?:const|let|var)\s*[{[]([^}\]]*)[}\]]/g))
    for (const n of m[1].split(',')) { const t = n.trim().split(/[:=]/).pop().trim(); if (/^\w+$/.test(t)) declared.add(t); }
  for (const m of code.matchAll(/\(([^)]*)\)\s*(?:=>|\{)/g))
    for (const n of m[1].split(',')) { const t = n.trim().replace(/[{}[\]]/g,'').split(/[:=]/)[0].replace(/\.\.\./,'').trim(); if (/^\w+$/.test(t)) declared.add(t); }
  for (const m of code.matchAll(/(\w+)\s*=>/g)) declared.add(m[1]);
  for (const m of code.matchAll(/\bcatch\s*\(\s*(\w+)/g)) declared.add(m[1]);

  const missing = new Set();
  for (const m of code.matchAll(/(?<![.\w$])([A-Za-z_$][\w$]*)\s*\(/g)) {
    const name = m[1];
    if (KEYWORDS.has(name) || declared.has(name)) continue;
    missing.add(name);
  }
  return [...missing];
}

// 직접 실행하면 결과를 출력한다. 테스트에서는 undefinedRefs를 가져다 쓴다.
if (import.meta.url === `file://${process.argv[1]}`) {
  const files = process.argv.length > 2 ? process.argv.slice(2) : sourceFiles();
  let bad = 0;
  for (const file of files) {
    const missing = undefinedRefs(file);
    if (missing.length) { bad += 1; console.log(`✗ ${file}: ${missing.join(', ')}`); }
    else console.log(`✓ ${file}`);
  }
  process.exit(bad ? 1 : 0);
}
