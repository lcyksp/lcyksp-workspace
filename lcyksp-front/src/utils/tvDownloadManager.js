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
    const interval = setInterval(async () => {
      const task = this.activeTasks[key]
      if (!task || task.taskId !== taskId) {
        clearInterval(interval)
        return
      }

      try {
        // silent: 404 等错误由这里自行处理，不走全局拦截器弹窗
        const res = await axios.get('/api/tv/download-status/' + taskId, { silent: true })
        if (res.data.status === 'completed') {
          clearInterval(interval)
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
          clearInterval(interval)
          ElMessage.error(task.epName + ' 下载失败: ' + (res.data.error || '未知错误'))
          delete this.activeTasks[key]
          this.saveToStorage()
        } else if (res.data.status === 'downloading') {
          if (res.data.progress) {
            task.progress = res.data.progress
          }
        }
      } catch (err) {
        // 任务在服务端不存在（服务重启会清空内存队列）：标记失效、停止轮询，只提示一次
        if (err.response?.status === 404) {
          clearInterval(interval)
          ElMessage.warning(task.epName + ' 的下载任务已失效（服务器已重启），请重新添加下载')
          delete this.activeTasks[key]
          this.saveToStorage()
          return
        }
        console.warn('Polling status failed for task:', taskId, err)
      }
    }, 3000)
  }
})

tvDownloadManager.init()
