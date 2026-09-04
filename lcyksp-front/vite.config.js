import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'
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
  plugins: [vue(), stripGlsl(), precompress()],
  build: {
    rollupOptions: {
      output: { manualChunks },
    },
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
