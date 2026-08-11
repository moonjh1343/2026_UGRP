#!/usr/bin/env node
/**
 * CDK 앱 진입점.
 *
 * 스택을 평면별로 나눈다 — 데이터 평면은 오래 살고(측정 결과가 들어 있다), 샤드
 * 평면은 실행할 때 띄우고 끝나면 내린다. 한 스택에 넣으면 샤드를 내리려다 데이터를
 * 같이 내리게 된다.
 */
import { join } from 'node:path'
import { App, Environment } from 'aws-cdk-lib'
import { NetworkStack } from '../lib/network-stack'
import { DataStack } from '../lib/data-stack'
import { ShardStack } from '../lib/shard-stack'
import { OrchestrationStack } from '../lib/orchestration-stack'
import { ServingStack } from '../lib/serving-stack'
import { ServingOriginStack } from '../lib/serving-origin-stack'
import {
  REGION,
  DEFAULT_COLLECTION,
  CollectionConfig,
  ImageDigests,
  requireShardCount,
  parseFilters,
} from '../lib/config'

const app = new App()

const env: Environment = {
  account: process.env.CDK_DEFAULT_ACCOUNT,
  region: app.node.tryGetContext('ugrp:region') ?? REGION,
}

const collection: CollectionConfig = {
  ...DEFAULT_COLLECTION,
  experiment: app.node.tryGetContext('ugrp:experiment') ?? DEFAULT_COLLECTION.experiment,
  /*
   * 데이터 네임스페이스는 스택 이름과 따로 받는다. 슬라이스를 별도 이름으로 모아도
   * VPC·결과 버킷은 그대로 재사용한다.
   */
  runName:
    app.node.tryGetContext('ugrp:runName') ??
    app.node.tryGetContext('ugrp:experiment') ??
    DEFAULT_COLLECTION.runName,
  filters: parseFilters(app.node.tryGetContext('ugrp:filters'), 'collection'),
  totalShards: requireShardCount(
    Number(app.node.tryGetContext('ugrp:shardCount') ?? DEFAULT_COLLECTION.totalShards),
    'collection',
  ),
  // -c ugrp:spot=true — CLI 컨텍스트는 문자열로 온다.
  spot: String(app.node.tryGetContext('ugrp:spot') ?? DEFAULT_COLLECTION.spot) === 'true',
}

const prefix = `Ugrp-${collection.experiment}`

const network = new NetworkStack(app, `${prefix}-Network`, { env })
const data = new DataStack(app, `${prefix}-Data`, { env, experiment: collection.experiment })

/*
 * 샤드 스택은 이미지 다이제스트가 있어야 만들어진다.
 *
 * 없을 때 자리표시자를 넣어 합성만 되게 하는 선택지도 있지만, 그러면 그 가짜 값이
 * 템플릿에 들어간 채로 배포될 여지가 생긴다. 대신 **스택을 아예 만들지 않고 이유를
 * 알린다** — 네트워크·데이터 평면은 다이제스트 없이도 합성되므로, 구조 검증은
 * 그대로 할 수 있다.
 */
/*
 * cdk.json의 context에 객체로 넣으면 객체로, `-c ugrp:digests={...}`로 주면 문자열로
 * 들어온다. CLI는 값을 파싱하지 않는다 — 양쪽을 다 받는다.
 */
const rawDigests = app.node.tryGetContext('ugrp:digests')
const digests: Partial<ImageDigests> =
  typeof rawDigests === 'string' ? JSON.parse(rawDigests) : (rawDigests ?? {})
const haveAll = Boolean(digests.sut && digests.worker && digests.load)

if (haveAll) {
  const shards = new ShardStack(app, `${prefix}-Shards`, {
    env,
    vpc: network.vpc,
    sutSg: network.sutSg,
    workerSg: network.workerSg,
    loadSg: network.loadSg,
    results: data.results,
    checkpoint: data.checkpoint,
    repos: data.repos,
    collection,
    digests,
  })
  shards.addStackDependency(network, 'VPC·보안 그룹')
  shards.addStackDependency(data, 'ECR 이미지·결과 버킷·체크포인트 테이블')

  /*
   * Spot 모드에서는 Orchestration을 만들지 않는다. 워커가 서비스로 돌므로 Step
   * Functions RunTask가 같은 태스크 정의를 또 띄우면 한 샤드에 워커가 둘이 되고,
   * 같은 셀을 이중 측정하며 부하 캘리브레이션을 서로 밟는다.
   */
  if (!collection.spot) {
    const orchestration = new OrchestrationStack(app, `${prefix}-Orchestration`, {
      env,
      vpc: network.vpc,
      workerSg: network.workerSg,
      cluster: shards.cluster,
      workerTaskDefinitions: shards.workerTaskDefinitions,
      collection,
    })
    orchestration.addStackDependency(shards, 'ECS 클러스터·워커 태스크 정의')
  } else {
    console.error(`[${prefix}] Spot 모드 — 워커는 서비스로 돌고 Orchestration 스택은 만들지 않는다.`)
  }
} else {
  console.error(
    `[${prefix}] 샤드 스택을 건너뛴다 — 이미지 다이제스트가 없다.\n` +
      '  scripts/push-images.sh 로 빌드·푸시한 뒤 cdk.json의 context에 넣는다:\n' +
      '    "ugrp:digests": { "sut": "sha256:...", "worker": "sha256:...", "load": "sha256:..." }\n' +
      '  구조만 확인하려면 임시 값을 인자로 줄 수 있다(cdk.json에는 넣지 말 것):\n' +
      "    npx cdk synth -c 'ugrp:digests={\"sut\":\"sha256:00\",\"worker\":\"sha256:00\",\"load\":\"sha256:00\"}'",
  )
}

/*
 * 정책 서빙 평면. 랩 수집과 독립이라 별도 컨텍스트로 켠다 —
 * 수집만 돌릴 때 CloudFront 배포(전파에 수십 분)를 기다릴 이유가 없다.
 *
 * **us-east-1 고정.** Lambda@Edge를 만들 수 있는 유일한 리전이다. 오리진은
 * ap-northeast-2에 있고, 그래도 된다 — 엣지 함수는 배포 후 전 로케이션에 복제된다.
 */
/*
 * 서빙 오리진(공개 ALB + SUT). 서빙 스택과 **별도 플래그·별도 배포**다 —
 * CloudFront가 오리진 도메인을 알아야 하는데, 그 값은 이 스택을 배포해야 나온다.
 *
 * 리전 간 자동 참조(crossRegionReferences)로 이을 수도 있지만, 커스텀 리소스
 * 람다가 양쪽 리전에 생기고 스택 삭제가 까다로워진다. 두 단계로 나누면 어떤
 * 오리진으로 배포했는지가 명령에 그대로 남는다.
 */
if (app.node.tryGetContext('ugrp:serveOrigin')) {
  if (!digests.sut) {
    throw new Error(
      `[${prefix}] 서빙 오리진에는 SUT 이미지 다이제스트가 필요하다. ` +
        'scripts/push-images.sh 로 올린 뒤 cdk.json의 ugrp:digests에 넣는다.',
    )
  }
  new ServingOriginStack(app, `${prefix}-ServingOrigin`, {
    env,
    sutDigest: digests.sut,
    sutRepositoryName: `${collection.experiment}-sut`,
    cloudfrontPrefixListId: app.node.tryGetContext('ugrp:cloudfrontPrefixList') ?? '',
    desiredCount: Number(app.node.tryGetContext('ugrp:servingTasks') ?? 2),
  })
}

const servingOrigin = app.node.tryGetContext('ugrp:servingOrigin')
if (servingOrigin) {
  const edgeDir = join(__dirname, '..', '..', 'edge')
  new ServingStack(app, `${prefix}-Serving`, {
    env: { account: env.account, region: 'us-east-1' },
    originDomainName: servingOrigin,
    edgeBundlePath: join(edgeDir, 'dist'),
    viewerFunctionPath: join(edgeDir, 'src', 'viewer-request.js'),
  })
} else if (haveAll) {
  console.error(
    `[${prefix}] 서빙 평면을 건너뛴다 — -c ugrp:servingOrigin=<오리진 도메인> 을 주면 만든다.\n` +
      '  먼저 edge/에서 번들을 빌드해야 한다: cd 03_Project/edge && npm run build -- --origin https://<오리진>',
  )
}

app.synth()
