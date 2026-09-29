// 全站共享的 pdfjs 入口：统一走 legacy 构建 + 单例 worker。
//
// 为什么用 legacy 构建而不是主构建：plugin-legacy 只转译主线程 chunk、不处理 worker 包，
// 而 pdfjs 主构建的 worker 里裸用 Promise.withResolvers（Chrome 119+/Firefox 121+/Safari 17.4+
// 才支持），旧浏览器的 modernPolyfills 只注入主线程够不到 worker 作用域，PDF 工具会全废。
// legacy 构建自带旧环境 polyfill，主线程和 worker 各自完整，不依赖外部 polyfill 清单。
// 单例 worker：各 PDF 工具间切换只养一个 worker，不再每个视图模块顶层各起一个。
import * as pdfjsLib from 'pdfjs-dist/legacy/build/pdf.mjs'
import PdfWorker from 'pdfjs-dist/legacy/build/pdf.worker.min.mjs?worker'

pdfjsLib.GlobalWorkerOptions.workerPort = new PdfWorker()
export default pdfjsLib
