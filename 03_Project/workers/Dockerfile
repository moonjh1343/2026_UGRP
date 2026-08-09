# 측정 워커 — Playwright + CDP 스로틀링.
#
# 베이스는 Playwright 공식 이미지다. 브라우저와 그 시스템 의존성(폰트, 코덱, libnss
# 등)이 함께 고정되어 있고, **브라우저 버전이 바뀌면 성능 특성이 바뀐다**는 것이
# 이 연구의 재현성 요구사항이다. 직접 apt로 조립하면 그 조합이 빌드 시점마다 달라진다.
#
# 태그의 1.57.0은 workers/package.json의 playwright와 **반드시 같아야 한다**.
# 다르면 이미지 안의 브라우저 바이너리와 클라이언트 라이브러리가 어긋나 실행 시점에
# 터진다. 올릴 때는 두 곳을 함께 올리고, 실험 메타데이터에 새 브라우저 버전이
# 기록되는지 확인한다(captureEnv가 잡는다).
#
# 빌드 컨텍스트는 03_Project/ 다 — run.mjs가 ../load/generator.mjs를 임포트한다:
#   docker build -f workers/Dockerfile -t ugrp-worker .
FROM mcr.microsoft.com/playwright:v1.57.0-noble

WORKDIR /app
ENV NODE_ENV=production

# 의존성 먼저. 소스만 바뀔 때 이 레이어가 재사용된다.
COPY workers/package.json workers/package-lock.json ./workers/
RUN cd workers && npm ci

# 워커와 부하 생성기는 한 이미지에 함께 둔다 — run.mjs가 generator.mjs를 직접
# 임포트하고, 로컬 실행과 같은 코드 경로를 쓰는 것이 곧 로컬/AWS 결과의 비교 가능성이다.
COPY workers/ ./workers/
COPY load/ ./load/

WORKDIR /app/workers

# BASE_URL은 샤드마다 다르다(자기 SUT의 Cloud Map DNS). 인프라가 주입한다.
ENV BASE_URL=http://127.0.0.1:3000

# 인자는 태스크 정의에서 override한다 — --name, --shard-index, --shard-count.
ENTRYPOINT ["node", "run.mjs"]
