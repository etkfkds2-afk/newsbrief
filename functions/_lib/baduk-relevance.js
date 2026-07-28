export function isBadukRelevant(title, body = '') {
  const titleText = String(title || '');
  const strongTitle = /(?:바둑(?:대회|리그|기전|기사|棋士|계)|대국|기전|한국기원|대한바둑협회|신진서|최정\s*9단|카타고|프로기사)/i;
  const badukContext = /(?:바둑|대국|기전|한국기원|대한바둑협회|프로기사|입단|단(?:\s|$)|棋士)/i;
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
  return /(?:바둑|대국|기전|한국기원|대한바둑협회|프로\s*기사|입단|棋士|신진서|최정|박정환|변상일|커제|이세돌|김은지|알파고|카타고|한돌|흑번|백번|포석|수읽기)/i
    .test(`${title || ''} ${body || ''}`);
}
