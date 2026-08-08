// 배포 전 퇴행 가드.
//
// 2026-08-08: 워크스페이스 체크아웃이 origin/main 보다 12KB 뒤처져 있는 걸 모르고
// 그대로 밀 뻔했다(APP_VERSION 20260802-7 → -1). 사람이 매번 알아채길 기대하는 대신
// 배포 직전에 기계가 막는다.
//
// 막는 것: ① APP_VERSION 역행 ② 파일 크기 급감 ③ hard delete 재등장
// 통과시키는 법: 커밋 메시지에 [force-regression] 을 넣는다(의도한 되돌리기일 때).

import { execSync } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';

const SHRINK_LIMIT = 0.05;          // 5% 넘게 줄면 차단
const FILES = ['TrainLog.html', 'TrainingLog/www-trainlog/dashboard.html'];

const msg = process.env.COMMIT_MESSAGE || '';
const forced = msg.includes('[force-regression]');

function prev(path) {
  try { return execSync(`git show HEAD~1:${path}`, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }); }
  catch { return null; }
}
function ver(s) { const m = s && s.match(/APP_VERSION\s*=\s*'([^']+)'/); return m ? m[1] : null; }

const problems = [];

for (const f of FILES) {
  if (!existsSync(f)) continue;
  const now = readFileSync(f, 'utf8');
  const was = prev(f);
  if (!was) { console.log(`${f}: 이전 버전 없음 — 검사 건너뜀`); continue; }

  const shrink = (was.length - now.length) / was.length;
  if (shrink > SHRINK_LIMIT) {
    problems.push(`${f}: ${was.length} → ${now.length} 바이트 (${(shrink * 100).toFixed(1)}% 감소)`);
  }

  const vNow = ver(now), vWas = ver(was);
  if (vNow && vWas && vNow < vWas) {
    problems.push(`${f}: APP_VERSION 역행 ${vWas} → ${vNow}`);
  }

  // soft-delete 전환(2026-08-08) 이후 hard delete 는 다시 들어오면 안 된다.
  // 보안 규칙이 delete 를 거부하므로 저장 자체가 실패하게 된다.
  const hard = (now.match(/\.delete\(\)/g) || []).length;
  if (hard > 0) problems.push(`${f}: hard delete 호출 ${hard}건 — 규칙이 거부하므로 저장이 실패한다`);

  console.log(`${f}: ${was.length} → ${now.length} 바이트, APP_VERSION ${vWas} → ${vNow}, hard delete ${hard}건`);
}

if (problems.length) {
  console.error('\n배포 차단 — 퇴행이 감지됐다:');
  problems.forEach(p => console.error('  · ' + p));
  if (forced) {
    console.error('\n[force-regression] 이 붙어 있어 통과시킨다.');
  } else {
    console.error('\n오래된 로컬 사본을 밀고 있는 게 아닌지 확인할 것.');
    console.error('의도한 변경이면 커밋 메시지에 [force-regression] 을 넣어 다시 밀면 된다.');
    process.exit(1);
  }
}
console.log('\n퇴행 가드 통과.');
