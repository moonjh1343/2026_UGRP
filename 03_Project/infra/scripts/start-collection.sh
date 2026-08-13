#!/bin/bash
# 본수집 시작 — Shards+Orchestration 배포 후 Step Functions 실행.
#
# 전제: Network·Data 스택 배포됨, cdk.json의 다이제스트가 시작하려는 빌드를
# 가리킴(이미지 버전이 실험 기록의 일부다 — push-images.sh 주석 참조).
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."

npx cdk deploy Ugrp-grid-v1-Shards Ugrp-grid-v1-Orchestration \
  -c ugrp:shardCount=20 --require-approval never 2>&1

# **배포가 서비스를 다 살려준다고 믿으면 안 된다.** desiredCount는 CFN 템플릿에서
# 1로 고정이지만, 실패 후 수동/자동(0 축소 Lambda)으로 0이 된 서비스는 템플릿과의
# 차이가 '드리프트'라 — 템플릿 변경이 없는 서비스(예: 이미지가 안 바뀐 load)는
# CFN이 건드리지 않고 0인 채로 남는다. grid-v1 3차 시도가 그렇게 죽었다:
# load-04가 0인 채여서 워커의 /vus 첫 호출이 fetch failed → 워커 즉사 → SFN 실패.
# 전 서비스를 명시적으로 1로 맞추고, 전부 안정될 때까지 기다린 뒤에 실행을 시작한다.
CLUSTER=$(aws ecs list-clusters --query "clusterArns[?contains(@,'Ugrp-grid-v1-Shards')]|[0]" --output text)
SERVICES=$(aws ecs list-services --cluster "$CLUSTER" --query 'serviceArns[]' --output text)
for svc in $SERVICES; do
  aws ecs update-service --cluster "$CLUSTER" --service "$svc" --desired-count 1 --query 'service.serviceName' --output text >/dev/null
done
echo "서비스 $(echo $SERVICES | wc -w)개 desiredCount=1 설정 — 안정화 대기"
# services-stable은 호출당 최대 10개까지만 받는다
echo $SERVICES | tr ' ' '\n' | xargs -n 10 | while read -r batch; do
  aws ecs wait services-stable --cluster "$CLUSTER" --services $batch
done
echo "전 서비스 안정화 완료"

ARN=$(aws cloudformation describe-stacks --stack-name Ugrp-grid-v1-Orchestration \
  --query "Stacks[0].Outputs[?OutputKey=='StateMachineArn'].OutputValue" --output text)
echo "STATE_MACHINE_ARN=$ARN"

EXEC_NAME="grid-v1-$(date +%Y%m%d-%H%M%S)"
EXEC_ARN=$(aws stepfunctions start-execution --state-machine-arn "$ARN" \
  --name "$EXEC_NAME" --query executionArn --output text)
echo "EXECUTION_ARN=$EXEC_ARN"
