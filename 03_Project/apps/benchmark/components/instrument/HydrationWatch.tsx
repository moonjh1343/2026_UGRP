/**
 * 하이드레이션 오류 카운터. 제안서 §3.5의 서킷 브레이커는
 * "하이드레이션 오류율 급증 시 전 트래픽 기본 모드로 복귀"를 규정하므로,
 * 그 판단 근거가 되는 지표를 앱이 내보내야 한다.
 *
 * **인라인 스크립트여야 한다.** 이전 구현은 useEffect에서 console.error를
 * 패치했는데, passive effect는 커밋 이후에 돌아서 초기 하이드레이션 패스의
 * 불일치 로그는 패치 설치 전에 이미 지나갔다 — 늦게 하이드레이션되는 stream의
 * Suspense 경계만 잡힐 수 있는, 탐지 자체가 모드 의존적인 상태였다. 게다가
 * React 18.2+/19 프로덕션은 불일치를 console.error가 아니라
 * onRecoverableError(기본값 reportError → window 'error' 이벤트)로 보고한다.
 *
 * 그래서 (a) 서버 컴포넌트가 렌더한 인라인 <script>로 하이드레이션 **전에**
 * 설치하고, (b) console.error와 window 'error' 이벤트 양쪽을 듣는다.
 * 다섯 모드 모두 같은 바이트가 렌더되므로 check:dom·check:determinism과
 * 충돌하지 않는다. Beacon이 페이지를 떠날 때 window.__hydrationErrors를 싣는다.
 */

const INSTALL = `(function(){
var w=window;if(w.__hydrationWatch)return;w.__hydrationWatch=1;
w.__hydrationErrors=w.__hydrationErrors||0;
function bump(t){if(t&&(t.indexOf('Hydration')!==-1||t.indexOf('hydrat')!==-1||t.indexOf('did not match')!==-1)){w.__hydrationErrors++}}
var orig=console.error;
console.error=function(){bump(String(arguments[0]||''));return orig.apply(console,arguments)};
w.addEventListener('error',function(e){bump(String((e.error&&e.error.message)||e.message||''))});
})();`

export function HydrationWatch() {
  // eslint-disable-next-line react/no-danger
  return <script dangerouslySetInnerHTML={{ __html: INSTALL }} />
}
