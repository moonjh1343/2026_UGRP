#!/bin/bash
# 본수집 시작 — Shards+Orchestration 배포 후 Step Functions 실행.
#
# 전제: Network·Data 스택 배포됨, cdk.json의 다이제스트가 시작하려는 빌드를
# 가리킴(이미지 버전이 실험 기록의 일부다 — push-images.sh 주석 참조).
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."

npx cdk deploy Ugrp-grid-v1-Shards Ugrp-grid-v1-Orchestration \
  -c ugrp:shardCount=20 --require-approval never 2>&1

ARN=$(aws cloudformation describe-stacks --stack-name Ugrp-grid-v1-Orchestration \
  --query "Stacks[0].Outputs[?OutputKey=='StateMachineArn'].OutputValue" --output text)
echo "STATE_MACHINE_ARN=$ARN"

EXEC_NAME="grid-v1-$(date +%Y%m%d-%H%M%S)"
EXEC_ARN=$(aws stepfunctions start-execution --state-machine-arn "$ARN" \
  --name "$EXEC_NAME" --query executionArn --output text)
echo "EXECUTION_ARN=$EXEC_ARN"
