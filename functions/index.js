/**
 * Team Bayern Skeleton — TrainLog Automated Report Functions
 *
 * 1. eveningTrainingReport  → 매일 21:00 KST  (당일 훈련 로그 요약)
 * 2. morningConditionReport → 매일 09:00 KST  (전날 컨디션 체크 요약)
 *
 * 이메일: jaemyung1287@gmail.com → 본인 받은편지함으로 전송
 */

const { onSchedule } = require('firebase-functions/v2/scheduler');
const { setGlobalOptions } = require('firebase-functions/v2');
const admin = require('firebase-admin');
const https = require('https');

admin.initializeApp();
setGlobalOptions({ region: 'asia-northeast3' }); // Seoul region

const COACH_EMAIL = 'jaemyung1287@gmail.com';

// ──────────────────────────────────────────────
//  Resend API로 이메일 전송 (node https 모듈 사용)
// ──────────────────────────────────────────────
async function sendEmail({ to, subject, text }) {
  const apiKey = process.env.RESEND_API_KEY;
  console.log(`[sendEmail] API key present: ${!!apiKey}, to: ${to}`);

  const body = JSON.stringify({
    from: 'TrainLog Bot <onboarding@resend.dev>',
    to,
    subject,
    text,
  });

  return new Promise((resolve, reject) => {
    const req = https.request(
      {
        hostname: 'api.resend.com',
        port: 443,
        path: '/emails',
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(body),
        },
      },
      (res) => {
        let data = '';
        res.on('data', (chunk) => { data += chunk; });
        res.on('end', () => {
          console.log(`[sendEmail] Resend status: ${res.statusCode}, body: ${data}`);
          if (res.statusCode >= 200 && res.statusCode < 300) {
            resolve(JSON.parse(data));
          } else {
            reject(new Error(`Resend error ${res.statusCode}: ${data}`));
          }
        });
      }
    );
    req.on('error', (err) => {
      console.error(`[sendEmail] Request error: ${err.message}`);
      reject(err);
    });
    req.write(body);
    req.end();
  });
}

// ──────────────────────────────────────────────
//  날짜 유틸
// ──────────────────────────────────────────────
function getKSTDateString(offsetDays = 0) {
  const now = new Date();
  // KST = UTC+9
  const kst = new Date(now.getTime() + 9 * 60 * 60 * 1000 + offsetDays * 86400000);
  return kst.toISOString().split('T')[0]; // YYYY-MM-DD
}

// ──────────────────────────────────────────────
//  체력 바 표시
// ──────────────────────────────────────────────
function bar(val, max = 10) {
  if (val == null) return '—';
  const filled = Math.round((val / max) * 5);
  return '█'.repeat(filled) + '░'.repeat(5 - filled);
}

function fatigueLabel(f) {
  if (f == null) return '—';
  if (f >= 8) return `🔴 ${f}`;
  if (f >= 6) return `🟡 ${f}`;
  return `🟢 ${f}`;
}

// ──────────────────────────────────────────────
//  Firestore 데이터 로드
// ──────────────────────────────────────────────
async function loadData() {
  const doc = await admin.firestore().collection('trainlog').doc('team').get();
  if (!doc.exists) throw new Error('Firestore document not found: trainlog/team');
  return doc.data();
}

// ──────────────────────────────────────────────
//  훈련 요약 포맷 (당일)
// ──────────────────────────────────────────────
function formatTrainingReport(data, date) {
  const athletes = data.athletes || [];
  const logs = (data.logs || []).filter(l => l.date === date);
  const athleteNames = athletes.map(a => a.name);

  const byAthlete = {};
  logs.forEach(l => {
    if (!l.athleteName) return;
    if (!byAthlete[l.athleteName]) byAthlete[l.athleteName] = [];
    byAthlete[l.athleteName].push(l);
  });

  const trained = new Set(Object.keys(byAthlete));
  const notTrained = athleteNames.filter(n => !trained.has(n));

  const lines = [];
  lines.push(`📋 Training Log Report — ${date}`);
  lines.push(`${'─'.repeat(40)}`);
  lines.push(`로그 완료: ${trained.size} / ${athleteNames.length}명\n`);

  for (const name of athleteNames) {
    if (!byAthlete[name]) continue;
    lines.push(`👤 ${name}`);
    for (const l of byAthlete[name]) {
      if (l.type === 'weight') {
        const exs = l.exercises || [];
        const pVol = exs
          .filter(e => e.trainingType === 'Power Development')
          .reduce((s, e) => s + (e.weight || 0) * (e.sets || 0) * (e.reps || 0), 0);
        const rVol = exs
          .filter(e => e.trainingType === 'Resistance Training')
          .reduce((s, e) => s + (e.weight || 0) * (e.sets || 0) * (e.reps || 0), 0);
        const total = l.totalVolume || 0;
        const parts = [];
        if (pVol > 0) parts.push(`Power Dev ${Math.round(pVol).toLocaleString()} kg`);
        if (rVol > 0) parts.push(`Resistance ${Math.round(rVol).toLocaleString()} kg`);
        if (!parts.length && total > 0) parts.push(`Total ${total.toLocaleString()} kg`);
        const rpe = l.rpe ? ` · RPE ${l.rpe}` : '';
        lines.push(`  🏋️  Weight — ${parts.join(' / ')}${rpe}`);
      } else if (l.type === 'sprint') {
        const dist = l.totalDistance || 0;
        const rpe = l.rpe ? ` · RPE ${l.rpe}` : '';
        lines.push(`  ⚡  Sprint — ${dist.toLocaleString()} m${rpe}`);
      } else if (l.type === 'plyo') {
        const reps = (l.totalReps || 0) + (l.totalContacts || 0);
        lines.push(`  🦘  Plyo — ${reps} reps/contacts`);
      }
    }
    lines.push('');
  }

  if (notTrained.length) {
    lines.push(`❌ Not Logged Today (${notTrained.length}명):`);
    notTrained.forEach(n => lines.push(`  · ${n}`));
    lines.push('');
  }

  lines.push(`${'─'.repeat(40)}`);
  lines.push(`Sent automatically by TrainLog Bot · 21:00 KST`);
  return lines.join('\n');
}

// ──────────────────────────────────────────────
//  컨디션 요약 포맷 (전날)
// ──────────────────────────────────────────────
function formatConditionReport(data, date) {
  const athletes = data.athletes || [];
  const condLogs = (data.logs || []).filter(l => l.date === date && l.type === 'condition');
  const athleteNames = athletes.map(a => a.name);

  const checkedIn = {};
  condLogs.forEach(l => { if (l.athleteName) checkedIn[l.athleteName] = l; });
  const notChecked = athleteNames.filter(n => !checkedIn[n]);

  const UPPER = new Set(['Neck', 'Shoulder', 'Chest', 'Back', 'Arm']);
  const LOWER = new Set(['Hip', 'Quad', 'Glute', 'Hamstring', 'Adductor', 'Calf', 'Ankle', 'Foot']);
  const CORE  = new Set(['Lower Back', 'Abs', 'Oblique']);

  const lines = [];
  lines.push(`🌅 Morning Condition Report — ${date}`);
  lines.push(`${'─'.repeat(40)}`);
  lines.push(`체크인: ${Object.keys(checkedIn).length} / ${athleteNames.length}명\n`);

  for (const name of athleteNames) {
    if (!checkedIn[name]) continue;
    const l = checkedIn[name];
    const { fatigue: f, mood: m, sleepQuality: sq, sleepHours: sh, soreness = [], notes } = l;

    lines.push(`👤 ${name}`);
    lines.push(`  😩 Fatigue    ${bar(f)}  ${fatigueLabel(f)}`);
    lines.push(`  😊 Mood       ${bar(m)}  ${m != null ? `${m}/10` : '—'}`);
    lines.push(`  😴 Sleep Q    ${bar(sq)}  ${sq != null ? `${sq}/10` : '—'}  (${sh != null ? `${sh}h` : '—'})`);

    const upper = soreness.filter(s => UPPER.has(s.part));
    const lower = soreness.filter(s => LOWER.has(s.part));
    const core  = soreness.filter(s => CORE.has(s.part));

    if (upper.length) lines.push(`  💙 Upper  ${upper.map(s => `${s.part} ${s.intensity}`).join(', ')}`);
    if (lower.length) lines.push(`  💚 Lower  ${lower.map(s => `${s.part} ${s.intensity}`).join(', ')}`);
    if (core.length)  lines.push(`  💜 Core   ${core.map(s => `${s.part} ${s.intensity}`).join(', ')}`);
    if (!soreness.length) lines.push(`  💪 Soreness: none`);
    if (notes) lines.push(`  📝 ${notes}`);
    lines.push('');
  }

  if (notChecked.length) {
    lines.push(`❌ 미체크인 (${notChecked.length}명):`);
    notChecked.forEach(n => lines.push(`  · ${n}`));
    lines.push('');
  }

  lines.push(`${'─'.repeat(40)}`);
  lines.push(`Sent automatically by TrainLog Bot · 09:00 KST`);
  return lines.join('\n');
}

// ──────────────────────────────────────────────
//  2026-08-04: 자동 리포트 메일 2종 삭제 (코치 요청)
//    - eveningTrainingReport  (매일 21:00 KST)
//    - morningConditionReport (매일 09:00 KST)
//  원본 코드는 index.js.bak-20260804 에 보관.
//  포맷 함수(formatTrainingReport / formatConditionReport)는 남겨둠.
// ──────────────────────────────────────────────
