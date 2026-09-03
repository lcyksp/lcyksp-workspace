import { reactive } from 'vue'
import axios from 'axios'
import { ElMessage } from 'element-plus'

const STORAGE_KEY = 'lcyksp_tv_download_tasks'

export const tvDownloadManager = reactive({
  activeTasks: {}, // key -> { taskId, status, progress, videoTitle, epName, index }

  init() {
    try {
      const saved = localStorage.getItem(STORAGE_KEY)
      if (saved) {
        const tasks = JSON.parse(saved)
        for (const key in tasks) {
          const task = tasks[key]
          this.activeTasks[key] = task
          this.pollDownloadStatus(key, task.taskId)
        }
      }
    } catch (e) {
      console.error('Failed to load saved TV tasks:', e)
    }
  },

  saveToStorage() {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(this.activeTasks))
    } catch (e) {
      console.error('Failed to save TV tasks:', e)
    }
  },

  async startDownload(videoInfo, ep, index) {
    if (!ep.m3u8Url) {
      ElMessage.error('该集无可用下载链接')
      return
    }

    const title = videoInfo?.title || '电视剧'
    const key = title + '_' + ep.name

    if (this.activeTasks[key]) {
      ElMessage.warning('该集已经在下载中')
      return
    }

    try {
      const epTitle = title + '_' + ep.name
      const res = await axios.post('/api/tv/download-episode', {
        m3u8Url: ep.m3u8Url,
        title: epTitle
      })

      const taskId = res.data.taskId
      this.activeTasks[key] = {
        taskId,
        status: 'downloading',
        progress: null,
        videoTitle: title,
        epName: ep.name,
        index: index
      }
      this.saveToStorage()
      this.pollDownloadStatus(key, taskId)
    } catch (err) {
      ElMessage.error(err.response?.data?.error || err.message || '启动下载失败')
    }
  },

  pollDownloadStatus(key, taskId) {
    // 原来是固定 3 秒 setInterval，async 回调还没有重入保护：后端一慢请求就会叠起来，
    // 而且除 404 以外的任何错误只 console.warn —— 标签页一直开着就永远每 3 秒敲一次后端。
    // 改成自调度 setTimeout：进度没变化就逐步退避，标签页不可见时降到 20 秒，
    // 连续失败 5 次或总时长超过 2 小时就放弃跟踪。
    const MIN_DELAY = 3000
    const MAX_DELAY = 15000
    const HIDDEN_DELAY = 20000
    const MAX_FAILURES = 5
    const deadline = Date.now() + 2 * 60 * 60 * 1000

    let delay = MIN_DELAY
    let failures = 0
    let lastProgress = ''

    const giveUp = (task, msg) => {
      ElMessage.warning(task.epName + msg)
      delete this.activeTasks[key]
      this.saveToStorage()
    }

    const tick = async () => {
      const task = this.activeTasks[key]
      if (!task || task.taskId !== taskId) return

      if (Date.now() > deadline) {
        giveUp(task, ' 的下载跟踪已超过 2 小时，停止轮询')
        return
      }

      // 后台标签页里浏览器本来就会节流定时器，这里显式降频，别把配额和后端 CPU 白烧掉
      if (document.hidden) {
        setTimeout(tick, HIDDEN_DELAY)
        return
      }

      try {
        // silent: 404 等错误由这里自行处理，不走全局拦截器弹窗
        const res = await axios.get('/api/tv/download-status/' + taskId, { silent: true })
        failures = 0
        if (res.data.status === 'completed') {
          task.progress = { size: '100%', speed: '下载中...', time: '' }

          ElMessage.success(task.epName + ' 服务器合成完成！正在获取并保存到本地...')

          try {
            const token = localStorage.getItem('lcyksp_token') || ''
            const downloadUrl = '/api/tv/download-file/' + taskId + '?token=' + encodeURIComponent(token)

            const link = document.createElement('a')
            link.href = downloadUrl
            link.download = key + '.mp4'
            document.body.appendChild(link)
            link.click()
            link.remove()
            ElMessage.success(task.epName + ' 下载已开始！请查看浏览器的下载列表')
          } catch (downloadErr) {
            ElMessage.error(task.epName + ' 触发下载失败')
          } finally {
            delete this.activeTasks[key]
            this.saveToStorage()
          }
        } else if (res.data.status === 'failed') {
          ElMessage.error(task.epName + ' 下载失败: ' + (res.data.error || '未知错误'))
          delete this.activeTasks[key]
          this.saveToStorage()
        } else if (res.data.status === 'downloading') {
          if (res.data.progress) {
            task.progress = res.data.progress
          }
          // 进度条没动就没必要继续每 3 秒问一次，ffmpeg 合成大集时能一动不动好几分钟
          const snapshot = JSON.stringify(res.data.progress || null)
          if (snapshot === lastProgress) {
            delay = Math.min(Math.round(delay * 1.5), MAX_DELAY)
          } else {
            lastProgress = snapshot
            delay = MIN_DELAY
          }
        }
      } catch (err) {
        // 任务在服务端不存在（服务重启会清空内存队列）：标记失效、停止轮询，只提示一次
        if (err.response?.status === 404) {
          giveUp(task, ' 的下载任务已失效（服务器已重启），请重新添加下载')
          return
        }
        failures += 1
        if (failures >= MAX_FAILURES) {
          giveUp(task, ' 的下载状态连续 5 次获取失败，已停止跟踪')
          return
        }
        delay = Math.min(delay * 2, MAX_DELAY)
        console.warn('Polling status failed for task:', taskId, err)
      }

      // completed / failed 分支都已经把 activeTasks 里的条目删掉了，不再排下一次
      if (!this.activeTasks[key]) return
      setTimeout(tick, delay)
    }

    setTimeout(tick, MIN_DELAY)
  }
})

tvDownloadManager.init()
