#!/bin/bash
# 본수집 감시 — 20분 주기 하트비트, 이상 시 종료(종료가 곧 보고 신호).
# usage: [WATCH_LOG=<path>] watchdog-grid.sh <execution-arn>
#
# 종료 코드: 0 실행 종료(성공/실패는 SFN 상태로 판단) · 2 60시간 상한 ·
# 3 부하 이탈(연속 2+ 또는 누적 12+) · 4 90분 무진행
set -u
EXEC_ARN="$1"
LOG="${WATCH_LOG:-/tmp/heartbeat-grid.log}"
DEADLINE=$(( $(date +%s) + 60*3600 ))   # 60시간 상한

TABLE=$(aws cloudformation describe-stack-resources --stack-name Ugrp-grid-v1-Data \
  --query "StackResources[?ResourceType=='AWS::DynamoDB::Table'].PhysicalResourceId" --output text)
LG=$(aws cloudformation describe-stack-resources --stack-name Ugrp-grid-v1-Shards \
  --query "StackResources[?ResourceType=='AWS::Logs::LogGroup'].PhysicalResourceId" --output text)

last_count=-1
last_change=$(date +%s)
drift_total=0

log() { echo "$(date -Is) $*" >> "$LOG"; }
log "watchdog 시작 exec=$EXEC_ARN table=$TABLE logGroup=$LG"

while true; do
  now=$(date +%s)
  if (( now > DEADLINE )); then log "EXIT: 60시간 상한 도달"; exit 2; fi

  status=$(aws stepfunctions describe-execution --execution-arn "$EXEC_ARN" \
    --query status --output text 2>>"$LOG") || status=UNKNOWN
  if [[ "$status" != "RUNNING" ]]; then log "EXIT: 실행 상태 $status"; exit 0; fi

  # 진행도 — grid-v1 파티션의 완료 항목 수 (셀 done + 메타/캘리브레이션 소수)
  count=$(aws dynamodb query --table-name "$TABLE" \
    --key-condition-expression "experiment = :e" \
    --expression-attribute-values '{":e":{"S":"grid-v1"}}' \
    --select COUNT --query Count --output text 2>>"$LOG") || count=$last_count
  if [[ "$count" != "$last_count" ]]; then last_change=$now; last_count=$count; fi
  stall_min=$(( (now - last_change) / 60 ))

  # 부하 이탈 — 최근 25분 창의 워커 로그.
  # filter-log-events는 페이지네이션되면 length(events)를 **페이지마다 한 줄씩**
  # 내놓는다 — 합산 없이는 "0\n0"이 산술 확장에 들어가 감시가 죽는다(실제로 죽었다).
  count_events() {
    aws logs filter-log-events --log-group-name "$LG" \
      --start-time $(( (now - 1500) * 1000 )) --filter-pattern "$1" \
      --query 'length(events)' --output text 2>>"$LOG" | awk '{s+=$1} END{print s+0}'
  }
  drift=$(count_events '"부하 이탈"') || drift=0
  drift_total=$(( drift_total + drift ))
  streak2=$(count_events '"부하 이탈 2/"') || streak2=0

  log "heartbeat status=$status done=$count stall=${stall_min}m drift_new=$drift drift_total=$drift_total streak2=$streak2"

  if (( streak2 > 0 )); then log "EXIT: 부하 이탈 연속 2회 이상 감지"; exit 3; fi
  if (( drift_total >= 12 )); then log "EXIT: 부하 이탈 누적 ${drift_total}회"; exit 3; fi
  if (( stall_min >= 90 )); then log "EXIT: ${stall_min}분 무진행"; exit 4; fi

  sleep 1200
done
