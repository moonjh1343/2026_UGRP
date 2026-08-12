/**
 * 정책 서빙 평면 — CloudFront + Lambda@Edge.
 *
 * 랩 수집 평면(shard-stack)과 **요구사항이 정반대다.** 랩에서는 ALB·CDN을 빼서
 * 홉과 분산을 줄였다. 여기서는 CDN이 있어야 한다 — 결정이 캐시와 상호작용하는 방식
 * 자체가 측정 대상이기 때문이다(캐시 파편화 비용, 제안서 §3.2).
 *
 * 캐시 키 설계가 이 스택의 핵심이다. `edge/README.md`에 근거를 적었고, 요약하면:
 *
 *   뷰어(모든 요청)   CloudFront Function — Client Hints → x-ugrp-bucket
 *   캐시 키           URL + x-ugrp-bucket
 *   오리진(미스에만)   Lambda@Edge — 모델 → x-render-mode
 *
 * 모드를 그대로 키에 넣으면 캐시가 요청마다 갈라져 히트율이 0이 되고, 아무것도 키에
 * 넣지 않으면 첫 요청이 채운 모드를 모든 기기가 받아 정책이 효과를 잃는다.
 */
import { Stack, StackProps, Duration, CfnOutput, RemovalPolicy } from 'aws-cdk-lib'
import * as cloudfront from 'aws-cdk-lib/aws-cloudfront'
import * as origins from 'aws-cdk-lib/aws-cloudfront-origins'
import * as lambda from 'aws-cdk-lib/aws-lambda'
import * as logs from 'aws-cdk-lib/aws-logs'
import { Construct } from 'constructs'

export interface ServingStackProps extends StackProps {
  /** 오리진. 서빙용 SUT 앞의 ALB. */
  originDomainName: string
  /** `edge/npm run build`가 만든 dist/ 경로. */
  edgeBundlePath: string
  /** 뷰어 함수 소스 (edge/src/viewer-request.js). */
  viewerFunctionPath: string
}

export class ServingStack extends Stack {
  readonly distribution: cloudfront.Distribution

  constructor(scope: Construct, id: string, props: ServingStackProps) {
    super(scope, id, props)

    /*
     * Lambda@Edge는 **us-east-1에만 만들 수 있다.** 이 스택이 다른 리전이면
     * 배포가 실패한다 — 합성 단계에서 막는다. 오리진(ap-northeast-2)과 리전이
     * 다른 것은 정상이다. 엣지 함수는 전 로케이션에 복제된다.
     */
    if (this.region !== 'us-east-1') {
      throw new Error(
        `[${id}] Lambda@Edge는 us-east-1에만 만들 수 있다 (현재 ${this.region}).\n` +
          '  bin/ugrp.ts에서 이 스택만 us-east-1로 지정한다. 오리진 리전과 달라도 된다 —\n' +
          '  엣지 함수는 배포 후 전 로케이션으로 복제된다.',
      )
    }

    // ── 뷰어 함수 — 모든 요청에서 돈다 ────────────────────────────────────
    const viewer = new cloudfront.Function(this, 'Bucketize', {
      code: cloudfront.FunctionCode.fromFile({ filePath: props.viewerFunctionPath }),
      runtime: cloudfront.FunctionRuntime.JS_2_0,
      comment: 'Normalize client hints into a cache-key bucket',
    })

    /*
     * 오리진 요청 함수 — 캐시 미스에서만 돈다.
     *
     * currentVersionOptions.removalPolicy가 RETAIN인 이유: Lambda@Edge 버전은
     * CloudFront가 참조를 놓을 때까지 지울 수 없다(복제본 정리에 수 시간 걸린다).
     * DESTROY면 스택 삭제가 그 시간 동안 실패를 반복한다.
     */
    const decide = new lambda.Function(this, 'Decide', {
      // nodejs20.x는 2026-04-30에 지원 종료됐다. edge/build.mjs의 esbuild target과 함께 올린다 —
      // 한쪽만 올리면 번들이 런타임에 없는 문법을 쓰거나 그 반대가 된다.
      runtime: lambda.Runtime.NODEJS_24_X,
      handler: 'index.handler',
      code: lambda.Code.fromAsset(props.edgeBundlePath),
      // 오리진 요청은 최대 30초지만, 결정은 밀리초 단위다. 길게 두면 장애 시 오래 매달린다.
      timeout: Duration.seconds(5),
      memorySize: 256,
      /*
       * Lambda@Edge는 환경변수를 지원하지 않는다. 설정은 번들에 구워져 있고
       * (edge/build.mjs), 그래서 "어떤 설정으로 돌았는가"가 이 버전에 고정된다.
       */
      currentVersionOptions: { removalPolicy: RemovalPolicy.RETAIN },
      /*
       * 로그 그룹을 직접 만든다(logRetention은 폐기됐다). 주의: Lambda@Edge는
       * **실행된 리전의** 로그 그룹에 쓴다. 이 그룹은 us-east-1의 것이고, 서울에서
       * 실행된 결정은 ap-northeast-2의 같은 이름 그룹에 남는다 — 조사할 때 리전을
       * 먼저 확인해야 한다.
       */
      logGroup: new logs.LogGroup(this, 'DecideLogs', {
        retention: logs.RetentionDays.ONE_MONTH,
        removalPolicy: RemovalPolicy.DESTROY,
      }),
    })

    /*
     * 캐시 정책 — **x-ugrp-bucket이 키에 들어간다.**
     *
     * 이 한 줄이 정책 서빙 평면 전체의 전제다. 빠지면 첫 요청이 채운 모드를 모든
     * 기기가 그대로 받아, 엣지가 무엇을 결정하든 사용자가 받는 것은 달라지지 않는다.
     */
    const cachePolicy = new cloudfront.CachePolicy(this, 'BucketAware', {
      comment: 'URL + normalized client bucket',
      headerBehavior: cloudfront.CacheHeaderBehavior.allowList('x-ugrp-bucket'),
      queryStringBehavior: cloudfront.CacheQueryStringBehavior.all(),
      // 세션 쿠키는 키에 넣지 않는다. 넣으면 사용자마다 캐시가 갈려 CDN이 무의미해진다 —
      // 개인화 라우트는 오리진이 Cache-Control: private로 스스로 빠져나간다.
      cookieBehavior: cloudfront.CacheCookieBehavior.none(),
      enableAcceptEncodingGzip: true,
      enableAcceptEncodingBrotli: true,
      defaultTtl: Duration.minutes(5),
      minTtl: Duration.seconds(0),
      maxTtl: Duration.hours(1),
    })

    /*
     * 오리진 요청 정책 — **뷰어가 보낸** 헤더 중 오리진에 넘길 것만 고른다.
     *
     * 캐시 키(cachePolicy)와 별개다. 여기 있는 헤더는 오리진에 전달되지만 캐시를
     * 가르지 않는다. 결정 헤더(x-render-mode 등)는 여기 넣지 않는다 — 그것들은
     * Lambda@Edge가 origin-request에서 요청에 직접 얹으므로 정책과 무관하게
     * 오리진에 도달하고, 여기 넣으면 뷰어가 같은 이름을 보내 결정 계층을 우회한
     * 관측(구분 불가능한 오염 행)을 만들 수 있다.
     */
    const originRequestPolicy = new cloudfront.OriginRequestPolicy(this, 'ForwardDecision', {
      comment: 'Forward the viewer hints the edge decision needs to the origin',
      headerBehavior: cloudfront.OriginRequestHeaderBehavior.allowList(
        'x-ugrp-bucket',
        'user-agent',
        'save-data',
      ),
      cookieBehavior: cloudfront.OriginRequestCookieBehavior.all(),
      queryStringBehavior: cloudfront.OriginRequestQueryStringBehavior.all(),
    })

    this.distribution = new cloudfront.Distribution(this, 'Cdn', {
      comment: 'UGRP adaptive rendering — serving plane',
      defaultBehavior: {
        origin: new origins.HttpOrigin(props.originDomainName, {
          protocolPolicy: cloudfront.OriginProtocolPolicy.HTTP_ONLY,
          readTimeout: Duration.seconds(30),
        }),
        viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        cachePolicy,
        originRequestPolicy,
        // Accept-CH를 모든 응답에 싣는다 — 브라우저가 다음 요청부터 Client Hints를
        // 보내야 뷰어 함수가 버킷을 접을 수 있다. (상관 ID는 middleware의 Server-Timing이 나른다.)
        responseHeadersPolicy: new cloudfront.ResponseHeadersPolicy(this, 'ExposeDecision', {
          comment: 'Advertise the client hints the bucket needs',
          customHeadersBehavior: {
            customHeaders: [
              { header: 'Accept-CH', value: 'Sec-CH-Device-Memory, Sec-CH-ECT, Downlink, RTT, Save-Data', override: false },
            ],
          },
        }),
        functionAssociations: [
          { function: viewer, eventType: cloudfront.FunctionEventType.VIEWER_REQUEST },
        ],
        edgeLambdas: [
          {
            functionVersion: decide.currentVersion,
            eventType: cloudfront.LambdaEdgeEventType.ORIGIN_REQUEST,
            // 결정에 쿠키(세션 전환 상한)가 필요하다. body는 필요 없다.
            includeBody: false,
          },
        ],
      },
      /*
       * 정적 자산은 결정 대상이 아니다. 엣지 함수를 붙이지 않아 불필요한 호출을 없애고,
       * 캐시도 버킷으로 가르지 않는다 — 같은 청크를 모든 버킷이 공유해야 한다.
       */
      additionalBehaviors: {
        '/_next/static/*': {
          origin: new origins.HttpOrigin(props.originDomainName, {
            protocolPolicy: cloudfront.OriginProtocolPolicy.HTTP_ONLY,
          }),
          viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
          cachePolicy: cloudfront.CachePolicy.CACHING_OPTIMIZED,
        },
      },
      priceClass: cloudfront.PriceClass.PRICE_CLASS_200,
      httpVersion: cloudfront.HttpVersion.HTTP2_AND_3,
      enableLogging: true,
      logIncludesCookies: false,
    })

    new CfnOutput(this, 'DistributionDomain', { value: this.distribution.distributionDomainName })
    new CfnOutput(this, 'EdgeFunctionVersion', { value: decide.currentVersion.version })
  }
}
