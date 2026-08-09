/**
 * 그리드 샤딩 (6단계 병렬 수집).
 *
 * 로컬 단일 프로세스로는 전체 그리드가 813시간이다. 줄일 방법은 병렬화뿐인데,
 * **부하 축이 외생이어야 한다**는 제약 때문에 프로세스만 늘릴 수는 없다 —
 * 두 워커가 같은 SUT를 때리면 서로의 부하 수준을 망가뜨린다. 그래서 AWS에서는
 * (SUT + k6 + 워커) 한 벌을 통째로 복제하고, 그리드를 그 샤드들에 나눈다.
 *
 * 이 파일은 **나누는 규칙**이다. 인프라가 아니라 실험 정의이므로 grid.mjs와 같은
 * 자리에 버전 관리된다 — "그때 어느 셀을 어느 샤드가 쟀는가"가 재현되지 않으면
 * 샤드 간 하드웨어 차이를 사후에 통제할 수 없다.
 *
 * 두 가지를 동시에 만족해야 한다:
 *
 *   1. **부하 수준별로 샤드를 가른다.** k6 VU 수는 목표 CPU%에 맞춰 이진 탐색으로
 *      고정한 값이라, 한 샤드가 부하 수준을 오가면 매번 재캘리브레이션해야 한다.
 *      샤드 하나는 부하 수준 하나만 맡는다.
 *
 *   2. **비용으로 나눈다, 개수로 나누지 않는다.** stale 셀은 재검증 창을 기다리느라
 *      반복당 62초, 나머지는 5초다. 12배 차이라 개수로 나누면 stale을 많이 받은
 *      샤드만 며칠 더 돌고 나머지는 논다.
 *
 * 동적 할당(DynamoDB 리스)을 쓰지 않는 이유: 어느 셀을 어느 샤드가 쟀는지가
 * 실행마다 달라지면, 샤드 간 하드웨어 편차가 특정 모드에 몰렸는지를 사후에 확인할
 * 수 없다. 정적 분할이면 배치가 시드로 재현되고, 아래 `dealBalanced`가 모드를
 * 샤드에 고르게 흩는다.
 */
import { makeRng, shuffle } from './grid.mjs'

/**
 * 셀 1회 반복의 예상 소요(초).
 *
 * stale은 ISR 재검증 창이 열리기를 기다려야 해서 지배적으로 크다. 정확할 필요는
 * 없고 **상대 비율만 맞으면** 된다 — 균형 분배에만 쓰이기 때문이다.
 */
export function repCostSeconds(cell) {
  return cell.cache === 'stale' ? 62 : 5
}

/** 셀 하나의 예상 소요(초). */
export function cellCostSeconds(cell, reps) {
  return repCostSeconds(cell) * reps
}

/**
 * LPT(Longest Processing Time first) 분배.
 *
 * 비싼 셀부터 그때그때 가장 한가한 샤드에 준다. 최적은 아니지만 최악의 경우에도
 * 최적의 4/3배 안이고, 여기서는 12배짜리 stale 셀을 흩는 것만으로 충분하다.
 *
 * 정렬 전에 시드로 섞는 이유: 같은 비용의 셀들이 그리드 생성 순서(기기 → 네트워크
 * → 라우트 → 모드) 그대로 남으면, 특정 모드가 특정 샤드에 뭉친다. 샤드마다 하드웨어
 * 편차가 있으므로 그 뭉침은 곧 모드에 실린 편향이다.
 */
export function dealBalanced(cells, shardCount, reps, seed = 'ugrp-2026') {
  if (shardCount < 1) throw new Error(`샤드 수가 ${shardCount}다 — 1 이상이어야 한다`)

  const order = shuffle(cells, makeRng(`${seed}|shard`))
    .map((c) => ({ cell: c, cost: cellCostSeconds(c, reps) }))
    // 안정 정렬이므로 같은 비용끼리는 위에서 섞은 순서가 유지된다.
    .sort((a, b) => b.cost - a.cost)

  const shards = Array.from({ length: shardCount }, () => ({ cells: [], costSeconds: 0 }))
  for (const { cell, cost } of order) {
    let lightest = shards[0]
    for (const s of shards) if (s.costSeconds < lightest.costSeconds) lightest = s
    lightest.cells.push(cell)
    lightest.costSeconds += cost
  }
  return shards
}

/**
 * 부하 수준별 샤드 배분.
 *
 * 부하 수준마다 일감의 크기가 다르지 않다(부하는 셀 수를 바꾸지 않는다) — 그래서
 * 균등 배분이 기본이지만, 총 샤드 수가 4의 배수가 아니면 나머지를 큰 쪽부터 준다.
 * 배분 자체를 코드로 두는 이유는 총 샤드 수를 바꿨을 때 배치가 자동으로 따라오게
 * 하기 위해서다 — 손으로 적으면 그 숫자가 또 하나의 어긋날 수 있는 사본이 된다.
 */
export function allocateShardsByLoad(cellsByLoad, totalShards) {
  const loads = Object.keys(cellsByLoad)
  if (totalShards < loads.length) {
    throw new Error(
      `샤드 ${totalShards}개로는 부하 수준 ${loads.length}개를 못 채운다 — ` +
        '샤드 하나가 부하 수준 하나만 맡는다는 규칙을 어기게 된다',
    )
  }

  const weight = Object.fromEntries(loads.map((l) => [l, cellsByLoad[l].length]))
  const total = Object.values(weight).reduce((a, b) => a + b, 0)

  // 최소 1개씩 준 뒤 나머지를 최대잔여법으로 배분한다.
  const alloc = Object.fromEntries(loads.map((l) => [l, 1]))
  let left = totalShards - loads.length
  const quota = loads.map((l) => ({
    load: l,
    exact: (weight[l] / total) * totalShards - 1,
  }))
  quota.sort((a, b) => b.exact - a.exact)
  for (let i = 0; left > 0; i = (i + 1) % loads.length) {
    const target = quota[i]
    if (target.exact <= 0) {
      // 남은 몫이 없는 수준까지 왔다 — 그래도 샤드가 남으면 큰 쪽부터 다시 돈다.
      if (quota.every((q) => q.exact <= 0)) {
        alloc[quota[0].load] += left
        left = 0
        break
      }
      continue
    }
    alloc[target.load]++
    target.exact--
    left--
  }
  return alloc
}

/**
 * 샤드 계획 전체. 워커 컨테이너가 자기 몫을 계산할 때와, 인프라가 태스크 수를
 * 정할 때 **같은 함수**를 쓴다.
 */
export function planShards({ cells, totalShards, reps, seed = 'ugrp-2026' }) {
  const byLoad = {}
  for (const c of cells) (byLoad[c.load] ??= []).push(c)

  const alloc = allocateShardsByLoad(byLoad, totalShards)
  const plan = []
  let index = 0
  for (const load of Object.keys(byLoad)) {
    const shards = dealBalanced(byLoad[load], alloc[load], reps, `${seed}|${load}`)
    shards.forEach((s, i) => {
      plan.push({
        shardIndex: index++,
        load,
        indexWithinLoad: i,
        shardsForLoad: alloc[load],
        cellCount: s.cells.length,
        costSeconds: s.costSeconds,
        cells: s.cells,
      })
    })
  }
  return plan
}
