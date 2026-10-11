<script setup>
import { ref, reactive, computed, onMounted } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import axios from 'axios'
import {
  Refresh, Promotion, Reading, CircleCheck, CircleClose, Warning,
  UploadFilled, Delete, View, Document, FolderOpened, EditPen,
} from '@element-plus/icons-vue'
import { extractTextFromFile, isSupported, SUPPORTED_EXT } from '../utils/kaodianImport.js'
import { ocrPdf, maxOcrPages } from '../utils/kaodianOcr.js'

const loading = ref(false)
const ready = ref(false)
const needPremium = ref(false)
const submitting = ref(false)

const meta = reactive({ total: 0, sources: [], categories: [], limits: {}, premium: false })

// 出题范围：'s0' = 内置教材；'c<分类名>' = 某分类下所有教材；'s<id>' = 单本教材
const scope = ref('s0')
const setup = reactive({
  chapter: '',
  type: 'recite',
  count: 5,
})

const queue = ref([])
const index = ref(0)
const current = ref(null)
const answer = ref('')
const result = ref(null)
const showStandard = ref(false)
const standard = ref(null)

const records = ref([])
const showRecords = ref(false)

// ---- 我的教材 ----
const showLibrary = ref(false)
const importing = ref(false)
const importStep = ref('')
const fileInput = ref(null)
const preview = reactive({ visible: false, loading: false, source: null, points: [], total: 0 })
// PDF 解析路线：auto = 有文字层用文字层、缺的页本地 OCR；text = 只用文字层；ocr = 全部 OCR
const parseMode = ref('auto')

// 扫描页 -> 浏览器本地 OCR
const ocrDlg = reactive({
  visible: false, running: false, line: '', progress: 0,
  file: null, parsed: null, title: '', pageCount: 0,
  from: 1, to: 1,
  pages: null,          // 非空数组 = 只识别这些页（缺文字层的页）；null = 按 from/to 区间
  onlyMissing: false,   // 勾选框：只识别没有文字层的页
  signal: null,
})

// 导入前的文本草稿（可编辑，OCR 出错时能自己修）
const draft = reactive({
  visible: false, busy: false, error: '',
  text: '', title: '', category: '', fileName: '', fileType: '', fileSize: 0, note: '',
})
const lastCategory = ref('')

// 编辑教材信息（改名 / 改分类）
const editDlg = reactive({ visible: false, busy: false, id: 0, title: '', category: '' })

// 窄屏适配：el-drawer 的 size 是内联样式，CSS 覆盖不了，只能 JS 响应
const narrowMQ = window.matchMedia('(max-width: 640px)')
const isNarrow = ref(narrowMQ.matches)
narrowMQ.addEventListener?.('change', (e) => { isNarrow.value = e.matches })
const drawerSize = (desktop) => (isNarrow.value ? '96%' : desktop)

const currentQ = computed(() => queue.value[index.value] || null)
const mySources = computed(() => meta.sources.filter((s) => !s.builtin))
const categoryName = computed(() => (scope.value.startsWith('c') ? scope.value.slice(1) : ''))

const scopeOptions = computed(() => {
  const groups = []
  const bi = meta.sources.find((s) => s.builtin)
  if (bi) groups.push({ label: '内置教材', options: [{ value: 's0', label: `内置：${bi.title}（${bi.pointCount}）` }] })
  if (meta.categories?.length) {
    groups.push({
      label: '按分类（多本一起背）',
      options: meta.categories.map((c) => ({
        value: 'c' + c.name,
        label: `${c.name} · ${c.count} 本 / ${c.pointCount} 考点`,
      })),
    })
  }
  if (mySources.value.length) {
    groups.push({
      label: '单本教材',
      options: mySources.value.map((s) => ({
        value: 's' + s.id,
        label: `${s.title}（${s.pointCount}）${s.category ? ' · ' + s.category : ''}`,
      })),
    })
  }
  return groups
})

const categoryNames = computed(() => (meta.categories || []).map((c) => c.name))

const activeSource = computed(() => {
  if (scope.value.startsWith('s')) {
    const id = Number(scope.value.slice(1))
    return meta.sources.find((s) => s.id === id) || null
  }
  return null
})

const chapterOptions = computed(() => {
  const map = new Map()
  const collect = (chapters) => {
    for (const c of chapters || []) {
      const key = c.chapter || '（未分类）'
      map.set(key, (map.get(key) || 0) + (c.n || 0))
    }
  }
  if (categoryName.value) {
    for (const s of mySources.value) {
      if (((s.category || '').trim() || '未分类') !== categoryName.value) continue
      collect(s.chapters)
    }
  } else if (activeSource.value) {
    collect(activeSource.value.chapters)
  }
  return [...map.entries()].map(([chapter, n]) => ({ chapter, n }))
})

function scopeValid(v) {
  if (v === 's0') return true
  if (v.startsWith('c')) return (meta.categories || []).some((c) => c.name === v.slice(1))
  const id = Number(v.slice(1))
  return meta.sources.some((s) => s.id === id)
}

async function loadMeta() {
  loading.value = true
  try {
    const { data } = await axios.get('/api/kaodian/meta')
    Object.assign(meta, data)
    ready.value = true
    if (!scopeValid(scope.value)) {
      scope.value = 's0'
      setup.chapter = ''
    }
  } catch (e) {
    if (e?.response?.status === 403) needPremium.value = true
    ready.value = false
  } finally {
    loading.value = false
  }
}

async function loadRecords() {
  try {
    const { data } = await axios.get('/api/kaodian/records', { params: { limit: 30 } })
    records.value = data.records || []
  } catch { /* 忽略 */ }
}

function onScopeChange() {
  setup.chapter = ''
  queue.value = []
  index.value = 0
  resetTurn()
}

async function startQuiz() {
  loading.value = true
  try {
    const params = { type: setup.type, count: setup.count, chapter: setup.chapter }
    if (scope.value.startsWith('c')) params.category = scope.value.slice(1)
    else params.source = scope.value.slice(1)
    const { data } = await axios.get('/api/kaodian/quiz', { params })
    if (!data.questions?.length) {
      ElMessage.warning(setup.type === 'judge'
        ? '这个范围里没有判断题。自建教材的辨析句是导入时按得分点生成的，可以重新导入或换背诵默写。'
        : '这个范围里没有可用题目，换个章节或换本教材试试')
      return
    }
    queue.value = data.questions
    index.value = 0
    resetTurn()
  } catch { /* 拦截器已提示 */ } finally {
    loading.value = false
  }
}

function resetTurn() {
  answer.value = ''
  result.value = null
  showStandard.value = false
  standard.value = null
}

async function submit() {
  const q = currentQ.value
  if (!q) return
  if (!answer.value.trim()) {
    ElMessage.warning('先写下你的答案吧')
    return
  }
  submitting.value = true
  try {
    if (q.type === 'judge') {
      const { data } = await axios.post('/api/kaodian/judge-answer', {
        pointId: q.id, source: q.source ?? 0, statement: q.statement, answer: answer.value,
      })
      result.value = { judge: true, ...data }
    } else {
      const { data } = await axios.post('/api/kaodian/score', {
        pointId: q.id, source: q.source ?? 0, answer: answer.value,
      })
      result.value = data
      standard.value = data.standard
    }
    loadRecords()
  } catch { /* 拦截器已提示 */ } finally {
    submitting.value = false
  }
}

async function revealStandard() {
  const q = currentQ.value
  if (!q) return
  try {
    const { data } = await axios.get(`/api/kaodian/points/${q.id}`, { params: { source: q.source ?? 0 } })
    standard.value = {
      title: data.title, body: data.body, thinking: data.thinking,
      judgements: data.judgements, pageFrom: data.pageFrom, pageTo: data.pageTo,
    }
    showStandard.value = true
  } catch { /* 拦截器已提示 */ }
}

function nextQuestion() {
  if (index.value + 1 >= queue.value.length) {
    ElMessage.info('这一轮背完啦，点「换一批」继续')
    return
  }
  index.value += 1
  resetTurn()
}

function retryCurrent() { resetTurn() }

function verdictMeta(v) {
  if (v === 'hit') return { label: '已答到', cls: 'ok' }
  if (v === 'suspect') return { label: '疑似答到', cls: 'warn' }
  return { label: '未答到', cls: 'bad' }
}

function scoreTone(score) {
  if (score >= 8) return 'great'
  if (score >= 5) return 'mid'
  return 'poor'
}

function fmtSize(n) {
  const v = Number(n) || 0
  if (v < 1024) return `${v} B`
  if (v < 1024 * 1024) return `${(v / 1024).toFixed(0)} KB`
  return `${(v / 1024 / 1024).toFixed(1)} MB`
}

// ---------- 上传自己的教材 ----------
function pickFile() {
  if (importing.value) return
  fileInput.value?.click()
}

async function onFileChange(ev) {
  const input = ev.target
  const file = input.files?.[0]
  input.value = ''
  if (!file) return
  if (!isSupported(file.name)) {
    ElMessage.warning(`不支持 ${file.name}，请上传 ${SUPPORTED_EXT.join(' / ')}`)
    return
  }
  importing.value = true
  try {
    importStep.value = '正在解析文件…'
    const parsed = await extractTextFromFile(file, { pdfMode: parseMode.value })
    importStep.value = ''
    const missing = parsed.ocrPages || []

    if (parsed.fileType === 'pdf' && (parseMode.value === 'ocr' || missing.length)) {
      // 有页需要 OCR（全部扫描 / 混合 / 强制 OCR）
      const allMissing = missing.length >= parsed.pageCount
      const cap = Math.min(parsed.pageCount, maxOcrPages())
      Object.assign(ocrDlg, {
        visible: true, running: false, line: '', progress: 0,
        file, parsed, title: parsed.title, pageCount: parsed.pageCount,
        from: missing.length && !allMissing ? missing[0] : 1,
        to: missing.length && !allMissing ? missing[missing.length - 1] : cap,
        pages: (!allMissing && parseMode.value === 'auto') ? missing : null,
        onlyMissing: !allMissing && parseMode.value === 'auto',
        signal: null,
      })
      if (parsed.pageCount > maxOcrPages()) {
        ElMessage.warning(`这份 PDF 有 ${parsed.pageCount} 页，OCR 一次上限 ${maxOcrPages()} 页`)
      }
      return
    }
    if (!parsed.text.trim()) {
      ElMessage.error('这份 PDF 没有可用的文字层。把解析方式切到「自动」或「全部 OCR」再试。')
      return
    }
    openDraft(parsed, parsed.text, '')
  } catch (e) {
    const msg = e?.response?.data?.error || e?.message || '解析失败'
    ElMessage.error(msg)
  } finally {
    importing.value = false
    importStep.value = ''
  }
}

function openDraft(parsed, text, note) {
  Object.assign(draft, {
    visible: true, busy: false, error: '', text,
    title: parsed.title || '', category: lastCategory.value || '',
    fileName: parsed.fileName, fileType: parsed.fileType,
    fileSize: parsed.fileSize, note: note || '',
  })
}

/** 开始浏览器本地 OCR */
async function startOcr() {
  const d = ocrDlg
  if (!d.file) return
  const from = Math.max(1, Math.min(Number(d.from) || 1, d.pageCount))
  const to = Math.max(from, Math.min(Number(d.to) || from, d.pageCount))
  d.from = from
  d.to = to
  // 只识别缺文字层的页（限定在用户选择的范围内）
  const missing = (d.onlyMissing && Array.isArray(d.pages))
    ? d.pages.filter((p) => p >= from && p <= to)
    : null
  d.running = true
  d.progress = 0
  d.line = '准备中…'
  d.signal = { aborted: false }
  const t0 = Date.now()
  try {
    const res = await ocrPdf(d.file, {
      from, to, pages: missing?.length ? missing : null,
      onProgress: (info) => { d.line = info.line; d.progress = info.progress },
      signal: d.signal,
    })
    if (!res.text.trim() && !String(d.parsed?.text || '').trim()) {
      ElMessage.error('OCR 没有识别出文字，换几页或提高渲染精度再试')
      d.running = false
      return
    }
    d.visible = false
    d.running = false
    // 按页序合成：文字层页用原文，OCR 页用识别结果
    let text = d.parsed?.text || ''
    let note = ''
    if (Array.isArray(d.parsed?.pdfPages) && d.parsed.pdfPages.some((p) => p.text == null)) {
      const ocrMap = new Map((res.pageNos || []).map((no, i) => [no, res.pageTexts[i] || '']))
      const parts = []
      for (const pg of d.parsed.pdfPages) {
        const t = pg.text != null ? pg.text : (ocrMap.get(pg.no) || '')
        if (t) parts.push(t)
      }
      text = parts.join('\n\n')
    }
    if (res.pages) {
      const pageDesc = missing?.length ? `缺文字层的 ${missing.length} 页` : `第 ${from}–${to} 页`
      note = `浏览器本地 OCR：${pageDesc}，用时 ${res.seconds.toFixed(0)} 秒。识别结果可能有错字，导入前可以直接在下面修改。`
    }
    openDraft(d.parsed, text, note)
    if (res.pages) ElMessage.success(`OCR 完成，共 ${res.pages} 页`)
  } catch (e) {
    d.running = false
    if (d.signal?.aborted) ElMessage.info('已取消 OCR')
    else ElMessage.error(`OCR 失败：${e?.message || e}`)
  }
}

function cancelOcr() {
  if (ocrDlg.signal) ocrDlg.signal.aborted = true
  ocrDlg.running = false
  ocrDlg.visible = false
}

/** 确认导入（文本已在草稿框里编辑过） */
async function confirmImport() {
  if (!draft.text.trim()) {
    draft.error = '文本是空的'
    return
  }
  draft.busy = true
  draft.error = ''
  try {
    const fd = new FormData()
    fd.append('title', draft.title || '')
    fd.append('category', draft.category || '')
    fd.append('fileName', draft.fileName || '')
    fd.append('fileType', draft.fileType || '')
    fd.append('fileSize', String(draft.fileSize || 0))
    fd.append('text', draft.text)
    const { data } = await axios.post('/api/kaodian/sources', fd, { timeout: 180000 })
    ElMessage.success(`导入成功：识别出 ${data.source.pointCount} 个考点、${data.source.keypointCount} 个得分点`)
    lastCategory.value = draft.category || ''
    draft.visible = false
    await loadMeta()
    scope.value = 's' + data.source.id
    onScopeChange()
  } catch (e) {
    draft.error = e?.response?.data?.error || e?.message || '导入失败'
  } finally {
    draft.busy = false
  }
}

async function openPreview(src) {
  preview.visible = true
  preview.loading = true
  preview.source = src
  preview.points = []
  try {
    const { data } = await axios.get(`/api/kaodian/sources/${src.id}/preview`, { params: { limit: 100 } })
    preview.source = data.source
    preview.points = data.points || []
    preview.total = data.total || 0
  } catch { /* 拦截器已提示 */ } finally {
    preview.loading = false
  }
}

function openEdit(src) {
  Object.assign(editDlg, {
    visible: true, busy: false, id: src.id,
    title: src.title, category: (src.category || '').trim(),
  })
}

async function saveEdit() {
  editDlg.busy = true
  try {
    await axios.put(`/api/kaodian/sources/${editDlg.id}`, {
      title: editDlg.title, category: editDlg.category,
    })
    ElMessage.success('已保存')
    editDlg.visible = false
    await loadMeta()
  } catch { /* 拦截器已提示 */ } finally {
    editDlg.busy = false
  }
}

async function removeSource(src) {
  try {
    await ElMessageBox.confirm(
      `确定删除《${src.title}》吗？它的 ${src.pointCount} 个考点会一并清除，不可恢复。`,
      '删除教材',
      { type: 'warning', confirmButtonText: '删除', cancelButtonText: '取消' },
    )
  } catch { return }
  try {
    await axios.delete(`/api/kaodian/sources/${src.id}`)
    ElMessage.success('已删除')
    if (scope.value === 's' + src.id) { scope.value = 's0'; onScopeChange() }
    await loadMeta()
  } catch { /* 拦截器已提示 */ }
}

onMounted(loadMeta)
</script>

<template>
  <div class="kaodian-view" v-loading="loading">
    <div class="page-head">
      <h1>考点背诵判分</h1>
      <p>语义判分，不搞字符串精确匹配。可以背内置的《{{ meta.sources?.[0]?.title || '内置教材' }}》，也可以导入自己的教材并按分类分组。</p>
    </div>

    <el-alert v-if="needPremium" type="warning" :closable="false" show-icon>
      此功能仅对高级用户开放。
    </el-alert>

    <el-alert v-else-if="!ready" type="info" :closable="false" show-icon>
      考点库尚未就绪 —— 可以点右上角「我的教材」导入自己的书来背。
    </el-alert>

    <template v-else>
      <section class="card setup">
        <div class="setup-row">
          <el-select v-model="scope" class="grow" @change="onScopeChange">
            <el-option-group v-for="g in scopeOptions" :key="g.label" :label="g.label">
              <el-option v-for="o in g.options" :key="o.value" :label="o.label" :value="o.value" />
            </el-option-group>
          </el-select>
          <el-select v-model="setup.chapter" placeholder="全部章节" clearable class="grow">
            <el-option label="全部章节" value="" />
            <el-option v-for="c in chapterOptions" :key="c.chapter" :label="`${c.chapter}（${c.n}）`" :value="c.chapter" />
          </el-select>
          <el-radio-group v-model="setup.type">
            <el-radio-button value="recite">背诵默写</el-radio-button>
            <el-radio-button value="judge">判断正误</el-radio-button>
          </el-radio-group>
          <el-input-number v-model="setup.count" :min="1" :max="30" />
          <el-button type="primary" :icon="Promotion" @click="startQuiz">开始练习</el-button>
          <el-button :icon="FolderOpened" @click="showLibrary = true">
            我的教材<span v-if="mySources.length" class="badge">{{ mySources.length }}</span>
          </el-button>
          <el-button :icon="Reading" @click="showRecords = true; loadRecords()">错题本</el-button>
        </div>
      </section>

      <section v-if="currentQ" class="qa">
        <div class="bubble coach">
          <div class="avatar">师</div>
          <div class="bubble-body">
            <div class="q-tag">
              {{ currentQ.chapter || (currentQ.source ? '我的教材' : '') }}<span v-if="currentQ.badge"> · {{ currentQ.badge }}</span>
            </div>
            <p class="q-text">{{ currentQ.question }}</p>
            <p v-if="currentQ.type === 'recite'" class="q-hint">共 {{ currentQ.keypointCount || '若干' }} 个得分点，按覆盖度给分</p>
            <p v-else class="q-hint">判断这句话的说法对不对</p>
          </div>
        </div>

        <div class="bubble me">
          <el-input
            v-model="answer"
            type="textarea"
            :rows="5"
            resize="vertical"
            :placeholder="currentQ.type === 'judge' ? '写「对」或「错」，最好再说说理由。' : '用自己的话复述这个考点。系统看的是意思对不对，不是字面像不像。'"
            :disabled="!!result || submitting"
          />
          <div class="me-actions">
            <span class="counter">{{ index + 1 }} / {{ queue.length }}</span>
            <el-button v-if="!result" type="primary" :icon="Promotion" :loading="submitting" @click="submit">提交</el-button>
            <template v-else>
              <el-button :icon="Refresh" @click="retryCurrent">再背一次</el-button>
              <el-button type="primary" @click="nextQuestion">下一题</el-button>
            </template>
            <el-button v-if="!result && currentQ.type === 'recite'" link @click="revealStandard">查看标准答案</el-button>
          </div>
        </div>

        <div v-if="result && !result.judge" class="bubble coach result">
          <div class="avatar">师</div>
          <div class="bubble-body">
            <div class="score-row">
              <span class="score" :class="scoreTone(result.score)">{{ result.score }}</span>
              <span class="score-max">/ {{ result.maxScore }}</span>
              <span v-if="result.llmUsed" class="llm-badge">已语义复核</span>
            </div>
            <p class="overall">{{ result.comment }}</p>

            <ul class="kp-list">
              <li v-for="(r, i) in result.results" :key="i" :class="verdictMeta(r.verdict).cls">
                <el-icon class="kp-icon">
                  <CircleCheck v-if="r.verdict === 'hit'" />
                  <Warning v-else-if="r.verdict === 'suspect'" />
                  <CircleClose v-else />
                </el-icon>
                <div class="kp-main">
                  <span class="kp-label">{{ verdictMeta(r.verdict).label }}</span>
                  <span class="kp-text">{{ r.keypoint }}</span>
                  <p v-if="r.comment" class="kp-comment">{{ r.comment }}</p>
                </div>
              </li>
            </ul>

            <p v-if="result.followUp" class="follow-up">追问：{{ result.followUp }}</p>

            <el-collapse v-model="showStandard" class="std-collapse">
              <el-collapse-item title="标准答案对照" name="1">
                <div v-if="standard" class="standard">
                  <p class="std-body">{{ standard.body }}</p>
                  <div v-if="standard.thinking" class="std-block">
                    <h4>命题思路</h4>
                    <p>{{ standard.thinking }}</p>
                  </div>
                  <div v-if="standard.judgements?.length" class="std-block">
                    <h4>辨析示例</h4>
                    <p v-for="(j, i) in standard.judgements" :key="i" :class="j.truth ? 'truth-ok' : 'truth-bad'">
                      {{ j.s }}（{{ j.truth ? '对' : '错' }}）
                    </p>
                  </div>
                  <p v-if="standard.pageFrom" class="src">
                    来源：第 {{ standard.pageFrom }}<span v-if="standard.pageTo && standard.pageTo !== standard.pageFrom">–{{ standard.pageTo }}</span> 页
                  </p>
                </div>
              </el-collapse-item>
            </el-collapse>
          </div>
        </div>

        <div v-else-if="result && result.judge" class="bubble coach result">
          <div class="avatar">师</div>
          <div class="bubble-body">
            <p class="judge-line">
              你的判断：<b :class="result.correct ? 'truth-ok' : 'truth-bad'">{{ result.got }}</b>
              ，正确答案：<b :class="result.expected === '对' ? 'truth-ok' : 'truth-bad'">{{ result.expected }}</b>
            </p>
            <p class="overall">{{ result.correct ? '判断正确！' : '判断有误，回到考点再看一遍。' }}</p>
          </div>
        </div>
      </section>

      <section v-else class="card empty">
        <p>选好教材（或一个分类）和范围，点「开始练习」，系统会随机抽题。</p>
        <p class="sub">想背自己的书？点「我的教材」上传 PDF / Word / Excel / Markdown / TXT，导入时可以给它们归类。</p>
      </section>
    </template>

    <!-- 我的教材 -->
    <el-drawer v-model="showLibrary" title="我的教材" :size="drawerSize('520px')">
      <div class="lib-upload">
        <input ref="fileInput" type="file" hidden :accept="SUPPORTED_EXT.map(e => '.' + e).join(',')" @change="onFileChange">
        <el-button type="primary" :icon="UploadFilled" :loading="importing" @click="pickFile">
          {{ importing ? '导入中…' : '上传教材' }}
        </el-button>
        <div class="mode-row">
          <span class="mode-label">PDF 解析方式</span>
          <el-radio-group v-model="parseMode" size="small">
            <el-radio-button value="auto">自动（推荐）</el-radio-button>
            <el-radio-button value="text">仅文字层</el-radio-button>
            <el-radio-button value="ocr">全部 OCR</el-radio-button>
          </el-radio-group>
        </div>
        <p class="lib-tip">自动：有文字层的页直接抽文字，扫描页在你浏览器里本地 OCR（不占服务器算力）</p>
        <p class="lib-tip">支持 {{ SUPPORTED_EXT.join(' / ') }}，单文件 ≤ 30MB</p>
        <p v-if="importStep" class="lib-step">{{ importStep }}</p>
      </div>

      <el-alert type="info" :closable="false" class="fmt-tip">
        <template #title>支持的格式</template>
        <div class="fmt-body">
          <p><b>问答式</b>：一行 <code>问：xxx</code>，下一行 <code>答：yyy</code></p>
          <p><b>标题式</b>：用标题样式，或 Markdown 的 <code>### 考点标题</code>，紧跟着写正文</p>
          <p><b>表格（Excel）</b>：第一列题干、第二列答案，其余列会拼进答案</p>
          <p><b>辨析句</b>：写一行 <code>辨析：xxx（对/错）</code>，不写对错时默认按错</p>
          <p><b>纯文本</b>：没有以上格式时，每个空行段落算一个考点，第一句作标题</p>
        </div>
      </el-alert>

      <div v-if="!mySources.length" class="empty-tip">还没导入过教材</div>
      <div v-for="s in mySources" :key="s.id" class="lib-item">
        <div class="lib-item-head">
          <el-icon class="lib-icon"><Document /></el-icon>
          <span class="lib-title" :title="s.title">{{ s.title }}</span>
          <el-tag v-if="s.category" size="small" effect="plain">{{ s.category }}</el-tag>
          <el-tag size="small" type="info">{{ s.fileType }}</el-tag>
        </div>
        <div class="lib-meta">
          {{ s.pointCount }} 个考点 · {{ s.keypointCount }} 个得分点 · {{ fmtSize(s.fileSize) }} · {{ (s.createdAt || '').slice(0, 16) }}
        </div>
        <div class="lib-actions">
          <el-button size="small" :icon="View" @click="openPreview(s)">查看考点</el-button>
          <el-button size="small" :icon="Promotion" @click="scope = 's' + s.id; onScopeChange(); showLibrary = false">用它出题</el-button>
          <el-button size="small" :icon="EditPen" @click="openEdit(s)">改名/归类</el-button>
          <el-button size="small" type="danger" plain :icon="Delete" @click="removeSource(s)">删除</el-button>
        </div>
      </div>
    </el-drawer>

    <!-- 考点预览 -->
    <el-drawer v-model="preview.visible" :title="preview.source?.title || '考点预览'" :size="drawerSize('560px')">
      <div v-if="preview.loading" class="empty-tip">加载中…</div>
      <template v-else>
        <p class="pv-meta">
          共 {{ preview.total }} 个考点 · {{ preview.source?.keypointCount }} 个得分点
          <span v-if="preview.source?.category"> · 分类「{{ preview.source.category }}」</span>
          <span v-if="preview.total > preview.points.length">（下面只显示前 {{ preview.points.length }} 个）</span>
        </p>
        <div v-for="p in preview.points" :key="p.id" class="pv-item">
          <div class="pv-title">
            <span class="pv-no">{{ p.no }}</span>{{ p.title }}
            <span class="pv-kp">{{ p.keypointCount }} 个得分点<span v-if="p.judgements?.length"> · {{ p.judgements.length }} 条辨析</span></span>
          </div>
          <p class="pv-body">{{ p.body }}</p>
          <div v-if="p.judgements?.length" class="pv-judges">
            <p v-for="(j, i) in p.judgements" :key="i" :class="j.truth ? 'truth-ok' : 'truth-bad'">
              {{ j.s }}（{{ j.truth ? '对' : '错' }}）
            </p>
          </div>
        </div>
      </template>
    </el-drawer>

    <el-drawer v-model="showRecords" title="答题记录 / 错题本" :size="drawerSize('420px')">
      <div v-if="!records.length" class="empty-tip">还没有记录</div>
      <div v-for="r in records" :key="r.id" class="record-item">
        <div class="record-head">
          <span class="record-score" :class="scoreTone(r.score)">{{ r.score }}分</span>
          <span class="record-chapter">{{ r.source ? '我的教材' : r.chapter }}</span>
        </div>
        <p class="record-title">{{ r.title }}</p>
        <span class="record-time">{{ r.created_at }}</span>
      </div>
    </el-drawer>

    <!-- 扫描页：浏览器本地 OCR -->
    <el-dialog v-model="ocrDlg.visible" :title="ocrDlg.onlyMissing ? '这份 PDF 有扫描页，需要 OCR' : '这份 PDF 是扫描版，需要 OCR'" width="min(560px, 94vw)" :close-on-click-modal="!ocrDlg.running" :show-close="!ocrDlg.running" @close="cancelOcr">
      <el-alert type="warning" :closable="false" show-icon class="ocr-alert">
        <template #title>{{ ocrDlg.onlyMissing ? '部分页面没有文字层' : '没有文字层' }}</template>
        <div class="ocr-alert-body">
          <template v-if="ocrDlg.onlyMissing">
            <p>这份 PDF 共 <b>{{ ocrDlg.pageCount }}</b> 页，其中 <b>{{ (ocrDlg.pages || []).length }}</b> 页没有文字层（其余页已直接抽到文字）。</p>
            <p>勾选「只识别扫描页」时只对缺文字层的页做 OCR，其余页用已抽好的文字 —— 又快又全。</p>
          </template>
          <template v-else>
            <p>这份 PDF 共 <b>{{ ocrDlg.pageCount }}</b> 页 —— 是整页扫描图，抽不出可编辑文字。</p>
          </template>
          <p><b>OCR 会全部在你的浏览器里跑</b>，服务器不参与计算。代价是要先下载约 4.5MB 的识别引擎（之后走缓存），大致每页几秒。</p>
        </div>
      </el-alert>

      <div class="ocr-range">
        <span>识别页码范围</span>
        <el-input-number v-model="ocrDlg.from" :min="1" :max="ocrDlg.pageCount" :disabled="ocrDlg.running" controls-position="right" />
        <span>—</span>
        <el-input-number v-model="ocrDlg.to" :min="1" :max="ocrDlg.pageCount" :disabled="ocrDlg.running" controls-position="right" />
        <span class="ocr-total">共 {{ ocrDlg.pageCount }} 页，单次上限 {{ maxOcrPages() }} 页</span>
      </div>
      <el-checkbox v-if="Array.isArray(ocrDlg.pages)" v-model="ocrDlg.onlyMissing" :disabled="ocrDlg.running" class="ocr-only-missing">
        只识别没有文字层的 {{ (ocrDlg.pages || []).length }} 页（其余页用文字层）
      </el-checkbox>

      <div v-if="ocrDlg.running" class="ocr-progress">
        <el-progress :percentage="Math.round(ocrDlg.progress * 100)" :stroke-width="10" />
        <p class="ocr-line">{{ ocrDlg.line }}</p>
      </div>

      <template #footer>
        <el-button :disabled="ocrDlg.running" @click="cancelOcr">取消</el-button>
        <el-button type="primary" :loading="ocrDlg.running" @click="startOcr">
          {{ ocrDlg.running ? '识别中…' : '开始本地 OCR' }}
        </el-button>
      </template>
    </el-dialog>

    <!-- 导入前：文本可编辑确认 -->
    <el-dialog v-model="draft.visible" title="确认导入内容" width="min(680px, 94vw)" :close-on-click-modal="!draft.busy" :show-close="!draft.busy">
      <el-alert v-if="draft.note" type="success" :closable="false" class="draft-note">{{ draft.note }}</el-alert>
      <div class="draft-grid">
        <div class="draft-title">
          <span>教材名称</span>
          <el-input v-model="draft.title" maxlength="60" :disabled="draft.busy" placeholder="给这本教材取个名字" />
        </div>
        <div class="draft-title">
          <span>分类</span>
          <el-select
            v-model="draft.category"
            :disabled="draft.busy"
            allow-create filterable clearable
            default-first-option
            placeholder="选已有分类或输入新分类，如「政治」"
            class="draft-cat"
          >
            <el-option v-for="c in categoryNames" :key="c" :label="c" :value="c" />
          </el-select>
        </div>
      </div>
      <p class="draft-hint">
        归好类，出题时就能「只背政治」或「政治大类下所有教材一起背」。
        下面是识别出的文字，可以直接改 —— 格式越规整，切出来的考点越准（<code>问：/答：</code> 或 <code>### 标题 + 正文</code>）。
      </p>
      <el-input v-model="draft.text" type="textarea" :rows="13" :disabled="draft.busy" class="draft-text" />
      <p class="draft-meta">{{ draft.text.length }} 字</p>
      <el-alert v-if="draft.error" type="error" :closable="false" class="draft-err">{{ draft.error }}</el-alert>

      <template #footer>
        <el-button :disabled="draft.busy" @click="draft.visible = false">取消</el-button>
        <el-button type="primary" :loading="draft.busy" @click="confirmImport">确认导入</el-button>
      </template>
    </el-dialog>

    <!-- 编辑教材信息 -->
    <el-dialog v-model="editDlg.visible" title="教材信息" width="min(460px, 94vw)">
      <div class="draft-title">
        <span>教材名称</span>
        <el-input v-model="editDlg.title" maxlength="60" :disabled="editDlg.busy" />
      </div>
      <div class="draft-title">
        <span>分类</span>
        <el-select
          v-model="editDlg.category"
          :disabled="editDlg.busy"
          allow-create filterable clearable
          default-first-option
          placeholder="如「政治」，留空为未分类"
          class="draft-cat"
        >
          <el-option v-for="c in categoryNames" :key="c" :label="c" :value="c" />
        </el-select>
      </div>
      <template #footer>
        <el-button :disabled="editDlg.busy" @click="editDlg.visible = false">取消</el-button>
        <el-button type="primary" :loading="editDlg.busy" @click="saveEdit">保存</el-button>
      </template>
    </el-dialog>
  </div>
</template>

<style scoped>
.kaodian-view { max-width: 900px; margin: 0 auto; padding: 8px 4px 60px; }
.page-head h1 { font-size: 22px; margin: 0 0 6px; }
.page-head p { color: var(--el-text-color-secondary); margin: 0 0 18px; font-size: 13px; }
.card { background: var(--el-bg-color-overlay); border: 1px solid var(--el-border-color-lighter); border-radius: 14px; padding: 16px; margin-bottom: 16px; }
.setup-row { display: flex; gap: 10px; flex-wrap: wrap; align-items: center; }
.grow { flex: 1 1 190px; min-width: 170px; }
.badge { margin-left: 5px; background: var(--el-color-primary); color: #fff; border-radius: 9px; padding: 0 6px; font-size: 11px; }
.qa { display: flex; flex-direction: column; gap: 14px; }
.bubble { display: flex; gap: 10px; }
.avatar { flex: 0 0 38px; width: 38px; height: 38px; border-radius: 50%; background: linear-gradient(135deg, #ffd166, #f0a020); color: #7a4a00; display: flex; align-items: center; justify-content: center; font-weight: 700; }
.bubble-body { flex: 1; background: var(--el-bg-color-overlay); border: 1px solid var(--el-border-color-lighter); border-radius: 14px; padding: 14px 16px; }
.bubble.me { flex-direction: column; }
.bubble.me .el-textarea { margin-bottom: 10px; }
.me-actions { display: flex; align-items: center; gap: 10px; }
.counter { margin-right: auto; color: var(--el-text-color-secondary); font-size: 12px; }
.q-tag { font-size: 12px; color: var(--el-color-primary); margin-bottom: 6px; }
.q-text { font-size: 17px; font-weight: 600; margin: 0 0 6px; line-height: 1.5; }
.q-hint { margin: 0; font-size: 12px; color: var(--el-text-color-secondary); }
.score-row { display: flex; align-items: baseline; gap: 6px; margin-bottom: 8px; }
.score { font-size: 34px; font-weight: 800; }
.score.great { color: #e63946; }
.score.mid { color: #f0a020; }
.score.poor { color: #8a8f98; }
.score-max { color: var(--el-text-color-secondary); }
.llm-badge { margin-left: 8px; font-size: 11px; padding: 2px 8px; border-radius: 999px; background: rgba(64,158,255,.15); color: #409eff; }
.overall { margin: 4px 0 12px; line-height: 1.6; }
.kp-list { list-style: none; padding: 0; margin: 0; display: flex; flex-direction: column; gap: 8px; }
.kp-list li { display: flex; gap: 8px; padding: 8px 10px; border-radius: 10px; border-left: 3px solid; background: var(--el-fill-color-light); }
.kp-list li.ok { border-color: #67c23a; }
.kp-list li.warn { border-color: #e6a23c; }
.kp-list li.bad { border-color: #f56c6c; }
.kp-icon { margin-top: 3px; }
.kp-list li.ok .kp-icon { color: #67c23a; }
.kp-list li.warn .kp-icon { color: #e6a23c; }
.kp-list li.bad .kp-icon { color: #f56c6c; }
.kp-main { flex: 1; }
.kp-label { font-size: 12px; color: var(--el-text-color-secondary); margin-right: 6px; }
.kp-text { line-height: 1.5; }
.kp-comment { margin: 4px 0 0; font-size: 12px; color: var(--el-text-color-secondary); }
.follow-up { margin: 12px 0 0; padding: 10px; border-radius: 10px; background: rgba(64,158,255,.08); font-size: 13px; }
.std-collapse { margin-top: 12px; }
.standard p { line-height: 1.7; margin: 6px 0; }
.std-block h4 { margin: 12px 0 4px; font-size: 13px; color: var(--el-color-primary); }
.truth-ok { color: #e63946; }
.truth-bad { color: #67c23a; }
.src { font-size: 12px; color: var(--el-text-color-secondary); }
.empty { text-align: center; color: var(--el-text-color-secondary); }
.empty .sub { font-size: 12px; }
.empty-tip { color: var(--el-text-color-secondary); text-align: center; padding: 30px 0; }
.record-item { padding: 10px 0; border-bottom: 1px solid var(--el-border-color-lighter); }
.record-head { display: flex; justify-content: space-between; font-size: 12px; }
.record-score { font-weight: 700; }
.record-score.great { color: #e63946; }
.record-score.mid { color: #f0a020; }
.record-score.poor { color: #8a8f98; }
.record-chapter { color: var(--el-text-color-secondary); }
.record-title { margin: 4px 0; }
.record-time { font-size: 11px; color: var(--el-text-color-secondary); }
/* 教材库 */
.lib-upload { text-align: center; padding: 8px 0 14px; border-bottom: 1px dashed var(--el-border-color); margin-bottom: 14px; }
.mode-row { display: flex; align-items: center; justify-content: center; gap: 8px; margin-top: 10px; flex-wrap: wrap; }
.mode-label { font-size: 12px; color: var(--el-text-color-secondary); }
.lib-tip { font-size: 12px; color: var(--el-text-color-secondary); margin: 8px 0 0; }
.lib-step { font-size: 12px; color: var(--el-color-primary); margin: 6px 0 0; }
.fmt-tip { margin-bottom: 14px; }
.fmt-body p { margin: 3px 0; font-size: 12px; line-height: 1.5; }
.fmt-body code { background: var(--el-fill-color); padding: 0 4px; border-radius: 4px; }
.lib-item { border: 1px solid var(--el-border-color-lighter); border-radius: 10px; padding: 12px; margin-bottom: 10px; }
.lib-item-head { display: flex; align-items: center; gap: 6px; }
.lib-icon { color: var(--el-color-primary); }
.lib-title { font-weight: 600; flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.lib-meta { font-size: 12px; color: var(--el-text-color-secondary); margin: 6px 0 10px; }
.lib-actions { display: flex; gap: 6px; flex-wrap: wrap; }
.pv-meta { font-size: 12px; color: var(--el-text-color-secondary); margin-bottom: 12px; }
.pv-item { padding: 10px 0; border-bottom: 1px solid var(--el-border-color-lighter); }
.pv-title { font-weight: 600; display: flex; align-items: baseline; gap: 6px; }
.pv-no { color: var(--el-color-primary); font-size: 12px; }
.pv-kp { margin-left: auto; font-size: 11px; font-weight: 400; color: var(--el-text-color-secondary); }
.pv-body { font-size: 13px; color: var(--el-text-color-regular); margin: 6px 0 0; line-height: 1.6; white-space: pre-wrap; }
.pv-judges { margin: 6px 0 0; padding: 8px 10px; border-radius: 8px; background: var(--el-fill-color-light); }
.pv-judges p { margin: 3px 0; font-size: 12px; line-height: 1.5; }
/* OCR / 草稿确认 */
.ocr-alert { margin-bottom: 14px; }
.ocr-alert-body p { margin: 4px 0; font-size: 12px; line-height: 1.6; }
.ocr-range { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; font-size: 13px; }
.ocr-range :deep(.el-input-number) { width: 120px; }
.ocr-total { color: var(--el-text-color-secondary); font-size: 12px; }
.ocr-only-missing { margin-top: 10px; }
.ocr-progress { margin-top: 16px; }
.ocr-line { margin: 8px 0 0; font-size: 12px; color: var(--el-text-color-secondary); }
.draft-note { margin-bottom: 12px; }
.draft-grid { display: flex; gap: 10px; margin-bottom: 10px; flex-wrap: wrap; }
.draft-title { display: flex; align-items: center; gap: 10px; flex: 1 1 260px; }
.draft-title > span { flex: 0 0 60px; font-size: 13px; color: var(--el-text-color-secondary); }
.draft-cat { flex: 1; }
.draft-hint { font-size: 12px; color: var(--el-text-color-secondary); line-height: 1.6; margin: 0 0 8px; }
.draft-hint code { background: var(--el-fill-color); padding: 0 4px; border-radius: 4px; }
.draft-text :deep(textarea) { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12.5px; line-height: 1.6; }
.draft-meta { font-size: 12px; color: var(--el-text-color-secondary); margin: 6px 0 0; text-align: right; }
.draft-err { margin-top: 10px; }
@media (max-width: 640px) {
  .page-head h1 { font-size: 18px; }
  .score { font-size: 28px; }
  .q-text { font-size: 16px; }
  .bubble-body { padding: 12px; }
  /* 窄屏下两个下拉各占整行，按钮自然换行 */
  .grow { flex: 1 1 100%; min-width: 0; }
  .me-actions { flex-wrap: wrap; }
  .draft-grid { flex-direction: column; }
  .lib-actions :deep(.el-button + .el-button) { margin-left: 0; }
}
</style>
