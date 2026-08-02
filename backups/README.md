# 백업

매일 새벽(독일 04:00 / 한국 11:00) GitHub Actions가 Firestore `trainlog` 컬렉션을
통째로 떠서 여기에 커밋한다. 사람이 할 일은 없다.

| 파일 | 내용 |
|------|------|
| `trainlog-latest.json.gz` | 가장 최근 스냅샷 (매일 덮어씀) |
| `daily/YYYY-MM-DD.json.gz` | 날짜별 스냅샷, 최근 30일치 |

30일이 지나 파일이 지워져도 **git 히스토리에는 영구히 남는다.** 저장소의
`backups/` 폴더 커밋 기록을 거슬러 올라가면 그날의 파일을 그대로 꺼낼 수 있다.

담기는 것: 선수 문서 + 로그 문서(`athlete_*/logs/*`) + 코치 문서 + 날짜별 플랜
(`coach/plans/*`) + 기록·프로그램·설정. Firestore 원본 형식 그대로라 정보 손실이 없다.

## 안전장치

문서 수가 비정상적으로 적으면(선수 문서 5개 미만 또는 로그 100건 미만) 스크립트가
**중단하고 아무것도 커밋하지 않는다.** 망가진 스냅샷으로 멀쩡한 어제치를 덮는 건
백업이 없는 것보다 나쁘기 때문이다.

## 꺼내 보기

```bash
gunzip -c backups/trainlog-latest.json.gz | python3 -m json.tool | less

# 특정 날짜
gunzip -c backups/daily/2026-08-02.json.gz > snapshot.json

# 30일보다 오래된 날짜 (git 히스토리에서)
git log --oneline -- backups/daily
git show <커밋해시>:backups/daily/2026-06-01.json.gz > old.json.gz
```

## 복원

**자동 복원 스크립트는 일부러 만들지 않았다.** 되돌리는 건 사람이 판단할 일이고,
"한 번에 되돌리는 버튼"은 그 자체가 새로운 유실 경로가 된다.

복원이 필요하면 스냅샷을 열어 필요한 로그만 골라 되돌린다. 로그 1건 = 문서 1건
(`trainlog/athlete_<id>/logs/<logId>`)이므로, 해당 문서만 다시 써 넣으면 다른
기록은 건드리지 않는다.

## 직접 돌리기

GitHub → Actions → **Backup Firestore** → Run workflow.
