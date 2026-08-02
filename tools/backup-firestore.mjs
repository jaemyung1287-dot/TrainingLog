// Firestore 백업 — trainlog 컬렉션 전체를 원본 형식 그대로 받아 gzip으로 저장한다.
// GitHub Actions에서 매일 돌고, 결과는 저장소에 커밋된다(= git 히스토리가 곧 백업 타임라인).
//
// 읽기는 Firebase 웹 API 키로 하는 REST 호출이다. 이 키는 원래 클라이언트에 박혀
// 공개되는 값이라 저장소에 있어도 비밀이 새는 게 아니다.
//
// 복원은 이 파일이 하지 않는다 — 되돌리는 건 사람이 판단할 일이고,
// 자동 복원 스크립트를 두면 그게 새로운 유실 경로가 된다.

import { writeFileSync, mkdirSync, readdirSync, rmSync } from 'node:fs';
import { gzipSync } from 'node:zlib';

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

const body = gzipSync(Buffer.from(JSON.stringify(snapshot), 'utf8'), { level: 9 });
const day = new Date().toISOString().slice(0, 10);
mkdirSync('backups/daily', { recursive: true });
writeFileSync('backups/trainlog-latest.json.gz', body);
writeFileSync(`backups/daily/${day}.json.gz`, body);

// 오래된 일일 스냅샷 정리. 지워도 git 히스토리에는 남는다.
const olds = readdirSync('backups/daily').filter(f => f.endsWith('.json.gz')).sort();
olds.slice(0, Math.max(0, olds.length - KEEP_DAYS)).forEach(f => rmSync(`backups/daily/${f}`));

console.log(`저장 완료: ${day} · ${top.length} + ${subTotal} docs · ${(body.length / 1024).toFixed(0)} KB`);
