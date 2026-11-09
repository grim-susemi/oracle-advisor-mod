# Atlas 자동 활성화 설치와 복귀

2026-11-05 후속 결과: generation-000003 설치 유지. 새 Atlas 호스트에서 자동 잡 J1과
실제 consult answered를 원장으로 확인했다. 실제 자문 누적 2/3회, 이번 변경 미커밋.
최종 결과:
`C:/Users/USER/orca/projects/기타 작업/.omo/evidence/oracle-atlas-auto/20261105-install/retry-result.md`

이전 실패 기록: generation-000003 설치를 시도했으나 실제 TUI의 `/ulw-execute`
진입 시험에서 자동 잡 표시 대기가 시간 초과되어 즉시 generation-000002로 복귀했다.
현재 관리 shim과 current.json은 보존본과 해시가 일치한다.
설치 결과·복귀 사본:
`C:/Users/USER/orca/projects/기타 작업/.omo/evidence/oracle-atlas-auto/20261105-install/`

실제 시험: Atlas 자동 잡과 실제 자문 응답 1회 성공, Sisyphus 잡 미생성 확인.
자문 총 1회 사용. 현재 인증 기준 재개 승인 후 시험 전후 인증 해시는 동일했다.
전체 check는 782/786 통과이며 과거 증거 관련 4개 실패가 남아 있다.
이는 설치 완료 또는 전체 검사 통과를 뜻하지 않는다.

| 에이전트 | 활성화 계약 |
|---|---|
| Atlas | 세션 시작 시 자동 잡 생성 |
| Sisyphus | 수동 `/oracle on` |
| Hephaestus | 수동 `/oracle on` |
| 그 외·정체성 불명 | 수동 `/oracle on` |

잡 생성은 모델 호출이 아니다. 실제 자문은 `oracle_consult`로 요청한다.
기존 수동 잡과 소유자의 일시정지·종료는 유지한다.
정체성 등록이 늦으면 첫 실제 턴에서 Atlas 여부를 다시 확인한다.

## 설치 전 조건

실제 Atlas 잡 생성과 자문 응답 1회, Sisyphus 잡 미생성 영수증을 확보한다.
자문 총 3회 이하이며 Atlas 시험은 최대 2회다.
기존 인증파일 변경 차단은 소유자 결정 없이 해제하지 않는다.
이 조건과 별도 설치 승인이 충족되기 전에는 아래 실사용 명령을 실행하지 않는다.

## 별도 설치 단계

관리 저장소:
`C:/Users/USER/orca/projects/piomo-oracle-advisor-mod`

대상 agent 디렉터리:
`C:/Users/USER/.omo-stable-500/home/.omo/agent`

1. 실행 중 작업이 끝난 시점에 현재 세대와 shim의 바이트 및 SHA-256을 증거 폴더에 보존한다.
   현재 확인된 세대는 `generation-000002`다. 설치 직전에 다시 읽고 달라졌으면 설치 계획을 재판정한다.
   보존 대상은 `oracle-advisor/current.json`과 `extensions/omo-oracle-advisor.js`다.
2. 저장소에서 `npm run build`를 실행한다.
3. 아래 dry-run 결과의 설정 정책 변경과 세대 번호를 확인한다.
4. 별도 승인 범위와 일치할 때만 실제 설치 명령을 실행한다.
5. 새 호스트가 새 세대를 로드하는지 확인한다. 기존 프로세스가 자동 갱신됐다고 가정하지 않는다.

```sh
node scripts/install.mjs --agent-dir "C:/Users/USER/.omo-stable-500/home/.omo/agent" --dry-run
node scripts/install.mjs --agent-dir "C:/Users/USER/.omo-stable-500/home/.omo/agent"
```

## 실패 시 이전 세대로 즉시 복귀

설치 승인에는 설치 실패 시 이전 세대로 복귀하는 조치를 함께 명시한다.
새 시험 프로세스만 종료하고, 보존한 `current.json`과 관리 shim을 원래 위치에
정확한 바이트로 복구한다. 이전 세대 파일과 routing.json은 수정하지 않는다.
shim은 이전 `integration/generation-000002/src/extension.mjs`를 다시 가리켜야 한다.
복구한 두 파일의 SHA-256을 보존본과 대조하고 새 호스트에서 이전 세대 로드를 확인한다.
현재 세대가 설치 전 조사와 달랐다면 그때 보존한 세대를 복귀 대상으로 삼는다.

설치기가 설정 정책을 변경했다면 해당 설치 manifest의 관리 범위만 복귀시킨다.
설정 전체를 과거 사본으로 덮어쓰지 않는다. 동시 수정으로 정책 drift가 확인되면
그 변경을 보존한 채 소유자에게 알린다.

이 문서 작성 시 설치·복귀 명령은 실행하지 않았다.
