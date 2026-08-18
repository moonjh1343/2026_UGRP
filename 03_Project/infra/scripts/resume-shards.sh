#!/bin/bash
# 일부 샤드만 재개 — SFN을 다시 띄우지 않고 워커 RunTask만 직접 건다.
# usage: resume-shards.sh <shard-index>...
#
# 왜 있나: grid-v1 본수집이 72시간 태스크 타임아웃(orchestration-stack.ts)에 걸려
# high 샤드 2개(15·18)가 480/520·446/520에서 잘렸다(2026-08-17 01:26). SFN을 새로
# 시작하면 끝난 샤드 18개도 SUT·부하를 띄우고 캘리브레이션을 치른 뒤에야 "할 셀
# 없음"으로 끝난다 — 샤드당 15~20분 × 3태스크를 헛되이 태운다. 워커는 체크포인트
# (DynamoDB)로 끝난 셀을 건너뛰므로, 남은 샤드의 SUT·부하만 1로 올리고 SFN이 쓰는
# 것과 같은 태스크 정의·서브넷·SG로 RunTask 하면 같은 실험이다.
#
# 단, SFN 밖이라 실패 시 자동 축소(ScaleDownOnFailure)가 없다 — 끝나면 사람이 0으로.
set -euo pipefail
SM=$(aws cloudformation describe-stack-resources --stack-name Ugrp-grid-v1-Orchestration \
  --query "StackResources[?ResourceType=='AWS::StepFunctions::StateMachine'].PhysicalResourceId" --output text)
CL=$(aws cloudformation describe-stack-resources --stack-name Ugrp-grid-v1-Shards \
  --query "StackResources[?ResourceType=='AWS::ECS::Cluster'].PhysicalResourceId" --output text)
DEF=$(aws stepfunctions describe-state-machine --state-machine-arn "$SM" --query definition --output text)

for i in "$@"; do
  pad=$(printf '%02d' "$i")
  read -r TD SUBNET SG < <(python3 -c '
import json,sys
d=json.loads(sys.argv[1]); p=d["States"]["AllShards"]["Branches"][int(sys.argv[2])]["States"]["Shard"+sys.argv[3]]["Parameters"]
n=p["NetworkConfiguration"]["AwsvpcConfiguration"]; print(p["TaskDefinition"], n["Subnets"][0], n["SecurityGroups"][0])' "$DEF" "$i" "$pad")
  svcs=$(aws ecs list-services --cluster "$CL" --max-items 200 --query 'serviceArns[]' --output text | tr '\t' '\n' | grep -E "(Sut|Load)${pad}Service")
  for s in $svcs; do aws ecs update-service --cluster "$CL" --service "$s" --desired-count 1 --query 'service.serviceName' --output text; done
  aws ecs wait services-stable --cluster "$CL" --services $svcs
  aws ecs run-task --cluster "$CL" --launch-type FARGATE --task-definition "$TD" \
    --network-configuration "awsvpcConfiguration={subnets=[$SUBNET],securityGroups=[$SG],assignPublicIp=DISABLED}" \
    --started-by "resume-shard-$pad" --query 'tasks[0].[taskArn,lastStatus]' --output text
done
