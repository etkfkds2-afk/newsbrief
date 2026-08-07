export function isBadukRelevant(title, body = '') {
  const titleText = String(title || '');
  const strongTitle = /(?:바둑(?:대회|리그|기전|기사|棋士|계)|대국|기전|한국기원|대한바둑협회|신진서|최정\s*9단|카타고|프로기사)/i;
  // 단은 반드시 숫자가 앞에 붙은 단수(9단)로만 인정한다. 예전 `단(?:\s|$)`는
  // "영암군민속씨름단 ", "배구단 ", "합창단 ", "구단 "에 모두 걸렸고, badukAction의
  // 우승·결승·개최와 짝을 이루면 팀 스포츠 기사가 통째로 바둑으로 분류됐다.
  // 실제로 씨름 기사(n.news.naver.com/mnews/article/119/0003119166)가 이 경로로
  // 들어왔다. 입단은 아래에 그대로 남는다.
  const badukContext = /(?:바둑|대국|기전|한국기원|대한바둑협회|프로기사|입단|[1-9]\s*단(?![가-힣])|棋士)/i;
  const badukAction = /(?:대국|우승|준우승|결승|본선|예선|출전|승리|패배|개최|개막|입단|바둑판|흑번|백번|수읽기|포석)/i;
  if (strongTitle.test(titleText) || (badukContext.test(titleText) && badukAction.test(titleText))) return true;
  const bodyText = String(body || '').slice(0, 5000);
  const signals = [
    /바둑/i, /한국기원/i, /대한바둑협회/i, /신진서/i, /최정\s*9단/i,
    /카타고/i, /(?:프로|아마추어)\s*기사/i, /(?:본선|결승|예선)\s*대국/i, /바둑리그/i
  ];
  return signals.filter(pattern => pattern.test(bodyText)).length >= 2 && badukAction.test(bodyText);
}

export function isBadukDisplayRelevant(title, body = '') {
  if (isBadukRelevant(title, body)) return true;
  // 최정(바둑 9단)은 씨름 장사 최정만과 앞 두 글자가 같다. 맨 이름으로 두면
  // 부분 문자열로 걸려서, 위 분류를 통과해 들어온 씨름 기사가 화면 필터까지
  // 그대로 통과했다. 두 버그가 겹쳐야 노출되므로 여기도 같이 막는다.
  return /(?:바둑|대국|기전|한국기원|대한바둑협회|프로\s*기사|입단|棋士|신진서|최정(?!만)|박정환|변상일|커제|이세돌|김은지|알파고|카타고|한돌|흑번|백번|포석|수읽기)/i
    .test(`${title || ''} ${body || ''}`);
}
