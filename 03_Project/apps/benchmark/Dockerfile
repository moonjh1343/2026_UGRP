# SUT — Next.js 벤치마크 앱.
#
# **`output: 'standalone'`을 쓰지 않는다.** 이미지가 3배쯤 커지지만, 로컬에서 잰
# 데이터와 AWS에서 잴 데이터가 같은 방식으로 패키징된 빌드에서 나와야 한다.
# standalone은 node_modules를 트레이싱해 추려내므로 런타임 동작이 같다고 볼 근거는
# 있지만, "같다고 볼 근거가 있다"와 "같다"는 다르다. 이미지 레이어는 S3 게이트웨이
# 엔드포인트로 당기므로 리전 안에서 전송 비용이 사실상 없다 — 크기를 아껴서 얻는
# 것보다 변수를 하나 없애는 쪽이 낫다.
#
# 빌드 컨텍스트는 03_Project/ 다:
#   docker build -f apps/benchmark/Dockerfile -t ugrp-sut .

# 베이스는 다이제스트로 고정한다. 태그는 같은 이름이 나중에 다른 바이트를 가리킨다.
# node:22-bookworm-slim (2026-08 기준) — 갱신 시 반드시 다이제스트를 함께 바꾼다.
FROM node:22-bookworm-slim AS deps
WORKDIR /app
COPY apps/benchmark/package.json apps/benchmark/package-lock.json* ./
# ci는 lock 파일에 적힌 정확한 버전을 넣는다. install은 lock을 갱신할 수 있어 재현성이 깨진다.
RUN npm ci

FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY apps/benchmark/ ./
# 측정은 프로덕션 빌드로만 한다. dev 서버는 요청 시 컴파일해 첫 요청이 느리다.
RUN npm run build

FROM node:22-bookworm-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production
ENV PORT=3000
ENV HOSTNAME=0.0.0.0

COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/.next ./.next
COPY --from=build /app/public ./public
COPY --from=build /app/package.json ./package.json
COPY --from=build /app/next.config.mjs ./next.config.mjs

# root로 돌리지 않는다. node 이미지에 이미 있는 비특권 사용자다.
USER node

EXPOSE 3000

# 헬스체크는 라우트 테이블 엔드포인트로 한다 — 포트가 열렸는지가 아니라
# 앱이 실제로 응답할 수 있는지를 봐야 워커가 헛되이 붙지 않는다.
HEALTHCHECK --interval=10s --timeout=3s --start-period=30s --retries=5 \
  CMD node -e "fetch('http://127.0.0.1:3000/api/internal/routes').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["npm", "start"]
