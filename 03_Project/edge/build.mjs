/**
 * 엣지 번들 빌드.
 *
 * 정책 계층은 TypeScript이고 `@/` 별칭을 쓴다. 그대로는 Lambda가 못 읽으므로 esbuild로
 * 묶는다. **복사하지 않고 임포트하는 것이 핵심이다** — 로직을 옮겨 적으면 랩에서
 * 검증한 것(`npm run check:policy`)이 필드 동작을 보증하지 않게 된다.
 *
 * 사용:
 *   node build.mjs --origin https://sut.example.com [--explore 0.05] [--policy surrogate]
 */
import { build } from 'esbuild'
import { readFile, writeFile, mkdir, rm } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const HERE = dirname(fileURLToPath(import.meta.url))
const APP = join(HERE, '..', 'apps', 'benchmark')
const OUT = join(HERE, 'dist')

const arg = (name, fallback = null) => {
  const i = process.argv.indexOf(`--${name}`)
  return i === -1 ? fallback : process.argv[i + 1]
}

const origin = arg('origin')
if (!origin) {
  console.error('--origin <URL> 이 필요하다 — 서버 상태를 어디서 읽을지 굽어야 한다')
  process.exit(1)
}
const explore = Number(arg('explore', '0.05'))
if (!(explore >= 0 && explore <= 1)) {
  console.error(`--explore 는 0~1 이어야 한다: ${explore}`)
  process.exit(1)
}
const policy = arg('policy', null)

await rm(OUT, { recursive: true, force: true })
await mkdir(OUT, { recursive: true })

/*
 * 설정을 굽는다. Lambda@Edge에 환경변수가 없어서 이 방법뿐이고, 결과적으로 어떤
 * 설정으로 배포됐는지가 Lambda 버전에 고정된다.
 */
const config = `// build.mjs가 생성한다. 직접 고치지 말 것 — 다음 빌드에 덮어쓰인다.
export const ORIGIN_URL = ${JSON.stringify(origin)}
export const EXPLORE_RATE = ${explore}
export const POLICY_NAME = ${policy === null ? 'null' : JSON.stringify(policy)}
`
await writeFile(join(HERE, 'src', 'config.generated.js'), config)

const result = await build({
  entryPoints: [join(HERE, 'src', 'origin-request.mjs')],
  bundle: true,
  platform: 'node',
  target: 'node24', // serving-stack.ts의 lambda.Runtime과 반드시 같이 올린다
  format: 'esm',
  outfile: join(OUT, 'index.mjs'),
  // 정책 계층의 `@/` 별칭과, 어댑터가 쓰는 `@policy`를 여기서 풀어준다.
  alias: {
    '@policy': join(APP, 'policy', 'index.ts'),
    '@': APP,
  },
  // 설정은 생성본을 쓴다. src/config.js는 편집용 원본이자 타입 참고다.
  plugins: [
    {
      name: 'config-swap',
      setup(b) {
        b.onResolve({ filter: /^\.\/config\.js$/ }, () => ({
          path: join(HERE, 'src', 'config.generated.js'),
        }))
      },
    },
  ],
  metafile: true,
  minify: true,
  legalComments: 'none',
})

const bytes = (await readFile(join(OUT, 'index.mjs'))).length
console.log(`번들 ${(bytes / 1024).toFixed(1)}KB → dist/index.mjs`)
console.log(`  오리진 ${origin} · 탐색률 ${explore} · 정책 ${policy ?? '(기본)'}`)

/*
 * 오리진 요청 Lambda@Edge의 압축 해제 상한은 50MB다. 여유가 크지만, 번들이 갑자기
 * 커졌다면 앱 코드가 딸려 들어왔다는 신호다 — 정책 계층은 app/·components/를
 * 임포트하지 않아야 하고 `check:policy`가 그 경계를 강제한다.
 */
const LIMIT_KB = 512
if (bytes / 1024 > LIMIT_KB) {
  console.error(
    `\n번들이 ${LIMIT_KB}KB를 넘었다. 정책 계층에 앱 코드가 딸려 들어왔을 가능성이 높다 —\n` +
      '  apps/benchmark에서 npm run check:policy 로 경계를 확인하라.',
  )
  const inputs = Object.entries(result.metafile.outputs[Object.keys(result.metafile.outputs)[0]].inputs)
    .sort((a, b) => b[1].bytesInOutput - a[1].bytesInOutput)
    .slice(0, 10)
  for (const [f, i] of inputs) console.error(`    ${(i.bytesInOutput / 1024).toFixed(1)}KB  ${f}`)
  process.exit(1)
}
