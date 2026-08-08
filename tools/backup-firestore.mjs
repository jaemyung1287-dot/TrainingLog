// Firestore 백업 — trainlog 컬렉션 전체를 원본 형식 그대로 받아 gzip으로 저장한다.
// GitHub Actions에서 매일 돌고, 결과는 저장소에 커밋된다(= git 히스토리가 곧 백업 타임라인).
//
// 읽기는 Firebase 웹 API 키로 하는 REST 호출이다. 이 키는 원래 클라이언트에 박혀
// 공개되는 값이라 저장소에 있어도 비밀이 새는 게 아니다.
//
// 복원은 이 파일이 하지 않는다 — 되돌리는 건 사람이 판단할 일이고,
// 자동 복원 스크립트를 두면 그게 새로운 유실 경로가 된다.

import { writeFileSync, mkdirSync, readdirSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { gzipSync, gunzipSync } from 'node:zlib';

const KEY = process.env.FIREBASE_API_KEY;
const PROJECT = process.env.FIREBASE_PROJECT || 'traininglogskeleton';
if (!KEY) { console.error('FIREBASE_API_KEY 없음'); process.exit(1); }

const BASE = `https://firestore.googleapis.com/v1/projects/${PROJECT}/databases/(default)/documents`;
const KEEP_DAYS = 30;

async function getJSON(url, tries = 4) {
  for (let i = 0; i < tries; i++) {
    try {
      const r = await fetch(url);
      const j = await r.json();
      if (j.error) throw new Error(`${j.error.code} ${j.error.message}`);
      return j;
    } catch (e) {
      if (i === tries - 1) throw e;
      await new Promise(r => setTimeout(r, 1500 * (i + 1)));
    }
  }
}

// 페이지네이션까지 따라가며 컬렉션의 모든 문서를 모은다.
async function listAll(path) {
  const out = [];
  let token = null;
  do {
    const url = `${BASE}/${path}?key=${KEY}&pageSize=300${token ? `&pageToken=${encodeURIComponent(token)}` : ''}`;
    const j = await getJSON(url);
    (j.documents || []).forEach(d => out.push(d));
    token = j.nextPageToken || null;
  } while (token);
  return out;
}

const snapshot = { _takenAt: new Date().toISOString(), _project: PROJECT, collections: {} };

const top = await listAll('trainlog');
snapshot.collections['trainlog'] = top;
console.log(`trainlog: ${top.length} docs`);

// 알려진 하위 컬렉션 — 로그는 문서 단위로 쪼개져 있으므로 여기까지 받아야 백업이 완전해진다.
let subTotal = 0;
for (const doc of top) {
  const id = doc.name.split('/').pop();
  const subs = id.startsWith('athlete_') ? ['logs'] : id === 'coach' ? ['plans'] : [];
  for (const sub of subs) {
    const docs = await listAll(`trainlog/${id}/${sub}`);
    if (docs.length) {
      snapshot.collections[`trainlog/${id}/${sub}`] = docs;
      subTotal += docs.length;
      console.log(`  ${id}/${sub}: ${docs.length} docs`);
    }
  }
}

// 백업이 비었거나 말이 안 되게 작으면 커밋하지 않는다 —
// 망가진 스냅샷으로 멀쩡한 어제치를 덮는 게 백업 없는 것보다 나쁘다.
if (top.length < 5 || subTotal < 100) {
  console.error(`백업 중단: 문서가 너무 적다 (top=${top.length}, sub=${subTotal})`);
  process.exit(1);
}

// ── 감소 감지 ─────────────────────────────────────────────────────────
// 위 절대 기준만으로는 753건이 200건이 돼도 그냥 통과한다. 로그는 쌓이기만 하는
// 데이터라 어제보다 줄었다면 그건 정상이 아니다(2026-07 유실 사고가 정확히 이 모양).
// 줄었으면 스냅샷을 쓰지 않고 실패로 끝낸다 — 어제치가 그대로 남아 있는 편이 낫고,
// 워크플로가 빨갛게 떠야 사람이 알아챈다.
// 로그는 이제 지워지지 않고 _deleted 표시만 남으므로(soft-delete) 정상 운영에서
// 문서 수가 줄어들 일은 없다.
function _prevCounts() {
  const prev = 'backups/trainlog-latest.json.gz';
  if (!existsSync(prev)) return null;
  try {
    const j = JSON.parse(gunzipSync(readFileSync(prev)).toString('utf8'));
    const cols = j.collections || {};
    // subTotal 과 같은 방식으로 센다 — 'trainlog' 최상위를 뺀 모든 하위 컬렉션
    // (athlete_*/logs 와 coach/plans). 한쪽만 세면 비교가 어긋난다.
    let sub = 0;
    const per = {};
    for (const [k, v] of Object.entries(cols)) {
      if (k === 'trainlog') continue;
      per[k] = v.length; sub += v.length;
    }
    return { top: (cols['trainlog'] || []).length, sub, per, takenAt: j._takenAt };
  } catch (e) {
    console.warn('이전 스냅샷을 읽지 못했다 — 감소 검사 건너뜀:', e.message);
    return null;
  }
}

const prev = _prevCounts();
if (prev) {
  const perNow = {};
  for (const [k, v] of Object.entries(snapshot.collections)) {
    if (k !== 'trainlog') perNow[k] = v.length;
  }
  const shrunk = [];
  if (top.length < prev.top) shrunk.push(`trainlog 문서 ${prev.top} → ${top.length}`);
  if (subTotal < prev.sub) shrunk.push(`로그 합계 ${prev.sub} → ${subTotal}`);
  for (const [k, n] of Object.entries(prev.per)) {
    const now = perNow[k] ?? 0;
    if (now < n) shrunk.push(`${k} ${n} → ${now}`);
  }
  if (shrunk.length) {
    console.error('백업 중단 — 어제보다 줄었다 (이전 스냅샷: ' + prev.takenAt + ')');
    shrunk.forEach(l => console.error('  · ' + l));
    console.error('덮어쓰지 않았다. 이전 백업은 그대로 남아 있다.');
    console.error('의도한 감소라면 backups/trainlog-latest.json.gz 를 손보고 다시 돌릴 것.');
    process.exit(1);
  }
  console.log(`감소 검사 통과: 하위문서 ${prev.sub} → ${subTotal} (+${subTotal - prev.sub})`);
} else {
  console.log('이전 스냅샷 없음 — 감소 검사 건너뜀(최초 실행)');
}

const body = gzipSync(Buffer.from(JSON.stringify(snapshot), 'utf8'), { level: 9 });
const day = new Date().toISOString().slice(0, 10);
mkdirSync('backups/daily', { recursive: true });
writeFileSync('backups/trainlog-latest.json.gz', body);
writeFileSync(`backups/daily/${day}.json.gz`, body);

// 오래된 일일 스냅샷 정리. 지워도 git 히스토리에는 남는다.
const olds = readdirSync('backups/daily').filter(f => f.endsWith('.json.gz')).sort();
olds.slice(0, Math.max(0, olds.length - KEEP_DAYS)).forEach(f => rmSync(`backups/daily/${f}`));

console.log(`저장 완료: ${day} · ${top.length} + ${subTotal} docs · ${(body.length / 1024).toFixed(0)} KB`);
