#!/usr/bin/env bash
#
# 이미지 3종을 빌드해 ECR에 올리고, **다이제스트를 찍어준다**.
#
# 다이제스트를 사람이 받아 적게 하는 이유: cdk.json에 들어가는 순간 그 값은 실험
# 기록의 일부가 된다. 스크립트가 파일을 직접 고치면 "언제 무엇이 바뀌었는가"가
# 커밋이 아니라 스크립트 실행 이력에만 남는다.
#
#   ./scripts/push-images.sh                 # 세 개 전부
#   ./scripts/push-images.sh worker          # 하나만
#
# 전제: Data 스택이 이미 배포돼 있어야 한다(ECR 저장소가 거기 있다).
set -euo pipefail

REGION="${AWS_REGION:-ap-northeast-2}"
EXPERIMENT="${UGRP_EXPERIMENT:-grid-v1}"
DATA_STACK="Ugrp-${EXPERIMENT}-Data"

# 빌드 컨텍스트는 03_Project/ 다 — 워커 이미지가 load/를 함께 담는다.
CONTEXT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"

# 태그는 커밋 SHA로 만든다. ECR 저장소가 IMMUTABLE이라 같은 태그를 두 번 밀 수 없고,
# 그게 곧 "커밋 하나당 이미지 하나"를 강제한다. dirty면 거부한다 — 커밋되지 않은
# 코드로 만든 이미지는 어떤 소스에서 나왔는지 복원할 수 없다.
cd "$CONTEXT"
if [ -n "$(git status --porcelain -- . 2>/dev/null)" ]; then
  echo "작업 트리가 깨끗하지 않다. 커밋한 뒤 빌드하라 —" >&2
  echo "  커밋되지 않은 코드로 만든 이미지는 다이제스트만 남고 소스를 복원할 수 없다." >&2
  exit 1
fi
TAG="$(git rev-parse --short=12 HEAD)"

declare -A DOCKERFILE=(
  [sut]="apps/benchmark/Dockerfile"
  [worker]="workers/Dockerfile"
  [load]="load/Dockerfile"
)
declare -A OUTPUT_KEY=(
  [sut]="SutRepoUri"
  [worker]="WorkerRepoUri"
  [load]="LoadRepoUri"
)

TARGETS=("$@")
if [ ${#TARGETS[@]} -eq 0 ]; then TARGETS=(sut worker load); fi

repo_uri() {
  aws cloudformation describe-stacks \
    --stack-name "$DATA_STACK" --region "$REGION" \
    --query "Stacks[0].Outputs[?OutputKey=='${OUTPUT_KEY[$1]}'].OutputValue" \
    --output text
}

REGISTRY="$(aws sts get-caller-identity --query Account --output text).dkr.ecr.${REGION}.amazonaws.com"
aws ecr get-login-password --region "$REGION" | docker login --username AWS --password-stdin "$REGISTRY"

echo
declare -A DIGEST
for name in "${TARGETS[@]}"; do
  uri="$(repo_uri "$name")"
  if [ -z "$uri" ] || [ "$uri" = "None" ]; then
    echo "$DATA_STACK 에서 ${OUTPUT_KEY[$name]} 를 찾지 못했다 — Data 스택을 먼저 배포하라" >&2
    exit 1
  fi

  echo "── $name ── $uri:$TAG"
  # linux/amd64 고정. 개발 머신이 arm이어도 Fargate에서 도는 것과 같은 바이너리여야
  # 한다 — 아키텍처가 다르면 성능 특성이 달라지고, 그게 곧 측정값이다.
  docker build --platform linux/amd64 -f "${DOCKERFILE[$name]}" -t "$uri:$TAG" "$CONTEXT"
  docker push "$uri:$TAG"

  DIGEST[$name]="$(aws ecr describe-images \
    --region "$REGION" \
    --repository-name "$(basename "$uri")" \
    --image-ids imageTag="$TAG" \
    --query 'imageDetails[0].imageDigest' --output text)"
  echo "   → ${DIGEST[$name]}"
  echo
done

echo "cdk.json 의 context 에 넣는다:"
echo
printf '    "ugrp:digests": {\n'
first=1
for name in sut worker load; do
  if [ -n "${DIGEST[$name]:-}" ]; then
    [ $first -eq 0 ] && printf ',\n'
    printf '      "%s": "%s"' "$name" "${DIGEST[$name]}"
    first=0
  fi
done
printf '\n    },\n'
echo
echo "커밋 $TAG 로 빌드했다. 실험 메타데이터의 이미지 버전과 일치해야 한다."
