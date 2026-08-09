# 배경 부하 생성기.
#
# **k6가 아니라 Node 생성기를 쓴다 — 제안서 §5.3과 다른 선택이므로 근거를 남긴다.**
#
# profile.json의 첫 줄이 그 이유를 이미 적고 있다: "k6 스크립트와 로컬 Node 생성기가
# 둘 다 이 파일을 읽는다 — 두 생성기가 서로 다른 부하를 주면 로컬 캘리브레이션 결과를
# 배포에 옮길 수 없다." 그 위험을 없애는 가장 확실한 방법은 생성기를 하나로 두는 것이다.
#
# k6를 쓸 이유였던 것(수만 VU)이 여기서는 해당되지 않는다. 캘리브레이션 결과 목표
# CPU 90%가 VU 71개다. thinkTime 1초를 넣어 VU당 기여를 ~3%로 낮춘 설계라 VU 수가
# 애초에 작다. Node 하나로 충분하다.
#
# 대신 k6가 공짜로 주던 것(리포팅, 분산 실행)은 없다. 필요해지면 그때
# generator.mjs와 k6 스크립트가 같은 부하를 내는지부터 검증해야 한다.
#
# 빌드 컨텍스트는 03_Project/ 다:
#   docker build -f load/Dockerfile -t ugrp-load .
FROM node:22-bookworm-slim

WORKDIR /app
ENV NODE_ENV=production

# 생성기는 의존성이 없다 — Node 내장 fetch만 쓴다. npm ci 단계 자체가 없다.
COPY load/ ./load/

WORKDIR /app/load

ENV BASE_URL=http://127.0.0.1:3000

EXPOSE 4000

# control.mjs는 VU 0으로 뜨고 **아무것도 하지 않는다.** 워커가 HTTP로 지시할 때까지
# 기다린다 — 캘리브레이션이 워커 쪽에 있기 때문이다(이진 탐색이 "VU를 놓고 SUT의 CPU를
# 읽는다"의 반복인데, CPU를 읽는 쪽이 워커다).
#
# VU 수를 여기 상수로 박지 않는 이유이기도 하다. 그 값은 태스크 크기에 종속이라
# Fargate에서 새로 잡아야 하고, 박아두면 calibration.generated.json과 어긋날 수 있는
# 사본이 하나 더 생긴다.
ENTRYPOINT ["node", "control.mjs"]
