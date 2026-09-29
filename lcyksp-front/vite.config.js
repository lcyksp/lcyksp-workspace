import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'
import legacy from '@vitejs/plugin-legacy'
import { readdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { brotliCompressSync, gzipSync, constants as zlib } from 'node:zlib'

// 构建时预压缩：生成 .br / .gz 与源文件并列，nginx 用 gzip_static / brotli_static 直接发送，
// 免掉每次缓存未命中时的实时 gzip CPU 开销（生产机只有 2 核）。
const PRECOMPRESS_EXT = /\.(?:js|mjs|css|html|json|svg|xml|txt|wasm)$/i
const PRECOMPRESS_MIN_BYTES = 1024

function precompress() {
  let outDir = ''
  return {
    name: 'lcyksp-precompress',
    apply: 'build',
    configResolved(config) {
      outDir = path.resolve(config.root, config.build.outDir)
    },
    async closeBundle() {
      const targets = []
      const walk = async (dir) => {
        for (const entry of await readdir(dir, { withFileTypes: true })) {
          const full = path.join(dir, entry.name)
          if (entry.isDirectory()) await walk(full)
          else if (PRECOMPRESS_EXT.test(entry.name)) targets.push(full)
        }
      }
      await walk(outDir)

      let raw = 0
      let gz = 0
      let br = 0
      for (const file of targets) {
        const buf = await readFile(file)
        if (buf.length < PRECOMPRESS_MIN_BYTES) continue
        const gzBuf = gzipSync(buf, { level: 9 })
        const brBuf = brotliCompressSync(buf, {
          params: {
            [zlib.BROTLI_PARAM_QUALITY]: 11,
            [zlib.BROTLI_PARAM_SIZE_HINT]: buf.length,
          },
        })
        await Promise.all([writeFile(`${file}.gz`, gzBuf), writeFile(`${file}.br`, brBuf)])
        raw += buf.length
        gz += gzBuf.length
        br += brBuf.length
      }

      const mb = (n) => `${(n / 1024 / 1024).toFixed(2)} MB`
      console.log(
        `\n[precompress] ${targets.length} 个文件 | 原始 ${mb(raw)} → gzip ${mb(gz)} / brotli ${mb(br)}`,
      )
    },
  }
}

// 着色器源码写在模板字符串里，压缩器一个字节都不会碰，注释会原样发到浏览器。构建时把
// /* glsl */ 标记过的模板里的整行注释和空行剥掉：仓库里那些推导过程照旧留着，产物里没有
function stripGlsl() {
  return {
    name: 'lcyksp-strip-glsl',
    apply: 'build',
    enforce: 'pre',
    transform(code) {
      if (!code.includes('/* glsl */')) return null
      // GLSL 里没有字符串字面量，`//` 只可能是注释；模板里也没有反引号和 ${}，
      // 所以「配到下一个反引号」就是完整的一段着色器
      const out = code.replace(/\/\* glsl \*\/ `([^`]*)`/g, (_, body) => {
        const kept = body.split('\n').filter((line) => {
          const t = line.trim()
          return t && !t.startsWith('//')
        })
        return `\`\n${kept.join('\n')}\n\``
      })
      return out === code ? null : { code: out, map: null }
    },
  }
}

// vendor 分包：把体积大且版本稳定的库拆成独立 chunk，配 1 年长缓存后业务代码更新不会连带失效。
function manualChunks(id) {
  const p = id.replace(/\\/g, '/')
  if (!p.includes('/node_modules/')) return
  if (p.includes('/node_modules/@tensorflow/')) return 'vendor-tfjs'
  if (p.includes('/node_modules/upscaler/') || p.includes('/node_modules/@upscalerjs/')) {
    return 'vendor-upscaler'
  }
  if (p.includes('/node_modules/pdfjs-dist/')) return 'vendor-pdfjs'
  if (p.includes('/node_modules/pdf-lib/')) return 'vendor-pdflib'
  if (p.includes('/node_modules/echarts/') || p.includes('/node_modules/zrender/')) {
    return 'vendor-echarts'
  }
  if (p.includes('/node_modules/jszip/')) return 'vendor-jszip'
  if (p.includes('/node_modules/three/')) return 'vendor-three'
  if (p.includes('/node_modules/element-plus/') || p.includes('/node_modules/@element-plus/')) {
    return 'vendor-element-plus'
  }
  if (
    p.includes('/node_modules/vue/') ||
    p.includes('/node_modules/@vue/') ||
    p.includes('/node_modules/vue-router/')
  ) {
    return 'vendor-vue'
  }
  // 其余交给 Rollup 默认分包，避免把冷门依赖误并进入口 chunk
}

// https://vite.dev/config/
export default defineConfig({
  // 浏览器兼容策略（2026-09 依生产 nginx 日志约 17k 请求的 UA 分布定）：
  // - 真人流量最低落在 Chrome 120 / Edge 90 / Firefox 121 / Safari 16.1，全部支持 ES module；
  //   日志里唯一的"老浏览器"（Chrome/59、Firefox/48/71、IE9-10，合计约 370 次）UA 串逐字节一致，
  //   是爬虫/扫描器，不是人。
  // - 因此不再生成 nomodule legacy 包（renderLegacyChunks: false）：那 6.7MB 产物没有真实受众，
  //   还明显拖慢构建；nomodule 浏览器由 index.html 的 Proxy 检测脚本提示升级。
  // - 兼容主力收敛到现代路径：build.target 钉语法底线（见下），modernPolyfills 枚举 API 缺口，
  //   覆盖"支持 module 但缺新 API"的 Win7/8 机器（Chrome 109-118、Firefox 115 ESR）。
  plugins: [
    vue(),
    stripGlsl(),
    legacy({
      renderLegacyChunks: false,
      // 用枚举而不用 true：true 会把全量 core-js（brotli 后约 45KB）注入每个现代访客的关键路径。
      // 这里只补 dist 实扫出的真实缺口——vendor-vue 用到 toSorted 家族（Chrome 110+ 才有）、
      // pdfjs 用到 withResolvers 的主线程部分（Chrome 119+ 才有；worker 部分由 pdfjs legacy
      // 构建自带 polyfill，见 utils/pdfjs.js）。
      modernPolyfills: [
        'es.promise.with-resolvers',
        'es.array.to-sorted',
        'es.array.to-reversed',
        'es.array.to-spliced',
        'es.array.with',
      ],
    }),
    precompress(),
  ],
  build: {
    // 显式钉死语法底线（等价 Vite 5 的 'modules' 预设）：不写死的话 Vite 升级会悄悄抬高
    // 底线（Vite 6 默认已改为 baseline-widely-available），兼容承诺会跟着漂移。
    target: ['es2020', 'edge88', 'firefox78', 'chrome87', 'safari14'],
    rollupOptions: {
      output: { manualChunks },
    },
  },
  // PDF 压缩的 worker 会把 pdfjs-dist 也打进去，产物需要 code-split，
  // 所以 worker 必须用 ESM 而不是默认的 iife（iife 不支持 code-splitting）。
  worker: {
    format: 'es',
  },
  server: {
    port: 5173,
    proxy: {
      '/api': {
        target: 'http://localhost:3000',
        changeOrigin: true,
      },
    },
  },
  preview: {
    port: 4173,
    proxy: {
      '/api': {
        target: 'http://localhost:3000',
        changeOrigin: true,
      },
    },
  },
})
