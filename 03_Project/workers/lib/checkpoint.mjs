/**
 * 셀 단위 체크포인트.
 *
 * 8,800셀 × 30회는 한 번에 끝나지 않는다. 중간에 멈췄다 이어붙일 수 없으면 실행이
 * 통째로 원자 단위가 되어, 마지막에 한 번 실패하면 전부 다시 돌려야 한다.
 * 배포에서는 Step Functions Distributed Map + DynamoDB가 이 역할을 하고,
 * 여기서는 같은 의미를 JSONL 두 벌로 낸다.
 *
 *   results.jsonl   측정 레코드 (append-only)
 *   done.jsonl      완료된 셀 id (재개 시 건너뛸 목록)
 *
 * append-only인 이유: 실행 중 프로세스가 죽어도 이미 쓴 줄은 유효하다. 전체를 다시 쓰는
 * 방식은 죽는 순간 파일이 반쯤 잘린다.
 */
import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises'

export class Checkpoint {
  constructor(dir) {
    this.dir = dir
    this.resultsPath = `${dir}/results.jsonl`
    this.donePath = `${dir}/done.jsonl`
    this.metaPath = `${dir}/experiment.json`
    this.done = new Set()
  }

  async open(meta) {
    await mkdir(this.dir, { recursive: true })

    try {
      const raw = await readFile(this.donePath, 'utf8')
      for (const line of raw.split('\n')) {
        if (line.trim()) this.done.add(JSON.parse(line).cellId)
      }
    } catch {
      /* 첫 실행 */
    }

    /*
     * 실험 메타데이터는 **덮어쓰지 않는다.** 재개인데 환경이 바뀌었다면(브라우저 업데이트,
     * 앱 재빌드) 앞뒤 데이터를 같은 데이터셋으로 볼 수 없다. 덮어쓰면 그 사실이 사라진다.
     */
    let existing = null
    try {
      existing = JSON.parse(await readFile(this.metaPath, 'utf8'))
    } catch {
      /* 첫 실행 */
    }

    if (existing) {
      const drift = []
      if (existing.env?.browser?.version !== meta.env?.browser?.version) drift.push('브라우저')
      if (existing.env?.next !== meta.env?.next) drift.push('Next.js')
      if (existing.env?.node !== meta.env?.node) drift.push('Node')
      if (existing.seeds?.order !== meta.seeds?.order) drift.push('순서 시드')
      return { resumed: true, doneCount: this.done.size, drift }
    }

    await writeFile(this.metaPath, JSON.stringify(meta, null, 2) + '\n')
    return { resumed: false, doneCount: 0, drift: [] }
  }

  has(cellId) {
    return this.done.has(cellId)
  }

  async record(row) {
    await appendFile(this.resultsPath, JSON.stringify(row) + '\n')
  }

  async complete(cellId, summary) {
    this.done.add(cellId)
    await appendFile(this.donePath, JSON.stringify({ cellId, ...summary }) + '\n')
  }
}
