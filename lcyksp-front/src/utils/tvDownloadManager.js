import { reactive } from 'vue'
import axios from 'axios'
import { ElMessage } from 'element-plus'

// 服务器流式代理（不落盘）：后端不再有「合成落盘」任务，前端也就不需要轮询状态、
// 不需要 localStorage 续跟踪。点下载 → 带登录态 POST 换一次性票据 →
// 用 ?ticket= 触发浏览器原生下载，进度/暂停/续传全交给浏览器自己的下载管理器。
export const tvDownloadManager = reactive({
  preparing: {}, // key -> true，仅在「换票 + 触发下载」这一小段时间为 true，用来禁用按钮

  async startDownload(videoInfo, ep, index) {
    if (!ep.m3u8Url) {
      ElMessage.error('该集无可用下载链接')
      return
    }

    const title = videoInfo?.title || '电视剧'
    const key = title + '_' + ep.name

    if (this.preparing[key]) return
    this.preparing[key] = true

    try {
      // 登录态自动带 Authorization 头换票；浏览器原生下载发不了该头，也禁止 ?token=
      // 走鉴权，只能用这张单次有效、5 分钟过期的短期票据。
      const res = await axios.post('/api/tv/stream-ticket', {
        m3u8Url: ep.m3u8Url,
        title: key
      }, { silent: true })

      const downloadUrl = '/api/tv/stream?ticket=' + encodeURIComponent(res.data.ticket)
      const link = document.createElement('a')
      link.href = downloadUrl
      link.download = key + '.mp4'
      document.body.appendChild(link)
      link.click()
      link.remove()

      ElMessage.success(ep.name + ' 下载已开始，请在浏览器下载列表查看进度')
    } catch (err) {
      ElMessage.error(err.response?.data?.error || err.message || '启动下载失败')
    } finally {
      delete this.preparing[key]
    }
  }
})
