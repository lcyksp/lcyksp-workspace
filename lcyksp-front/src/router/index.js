import { createRouter, createWebHistory } from 'vue-router'
import { ElMessage } from 'element-plus'

// 首页是落地页，保持静态引入，避免首屏多一次 chunk 往返；其余路由全部懒加载
import HomePageView from '../views/HomePageView.vue'

function readCurrentUser() {
  try {
    const raw = localStorage.getItem('lcyksp_user')
    return raw ? JSON.parse(raw) : null
  } catch {
    return null
  }
}

function canAccessGallery(user) {
  if (!user) return false
  if (user.role === 'admin' || user.role === 'premium') return true
  return Boolean(user.groupId)
}

const routes = [
  { path: '/', name: 'home', component: HomePageView },
  { path: '/transmit', name: 'transmit', component: () => import('../views/TransmitView.vue') },
  { path: '/transmit/:id', name: 'receive', component: () => import('../views/ReceiveView.vue') },
  { path: '/compress', name: 'compress', component: () => import('../views/CompressView.vue') },
  { path: '/convert', name: 'convert', component: () => import('../views/ConvertView.vue') },
  { path: '/recipe', name: 'recipe', component: () => import('../views/RecipeView.vue') },
  { path: '/gallery', name: 'gallery', component: () => import('../views/GalleryView.vue') },
  { path: '/pixel-art', name: 'pixel-art', component: () => import('../views/PixelArtConverter.vue') },
  { path: '/obfuscate', name: 'obfuscate', component: () => import('../views/ObfuscateView.vue') },
  { path: '/watermark', name: 'watermark', component: () => import('../views/WatermarkView.vue') },
  { path: '/pdf-merge', name: 'pdf-merge', component: () => import('../views/PdfMergeView.vue') },
  { path: '/pdf-split', name: 'pdf-split', component: () => import('../views/PdfSplitView.vue') },
  { path: '/img-to-pdf', name: 'img-to-pdf', component: () => import('../views/ImgToPdfView.vue') },
  { path: '/pdf-to-img', name: 'pdf-to-img', component: () => import('../views/PdfToImgView.vue') },
  { path: '/pdf-extract-text', name: 'pdf-extract-text', component: () => import('../views/PdfExtractTextView.vue') },
  { path: '/pdf-page-editor', name: 'pdf-page-editor', component: () => import('../views/PdfPageEditorView.vue') },
  { path: '/pdf-watermark', name: 'pdf-watermark', component: () => import('../views/PdfWatermarkView.vue') },
  { path: '/pdf-sign', name: 'pdf-sign', component: () => import('../views/PdfSignView.vue') },
  { path: '/pdf-to-word', name: 'pdf-to-word', component: () => import('../views/PdfToWordView.vue') },
  { path: '/video-download', name: 'video-download', component: () => import('../views/VideoDownloadView.vue') },
  { path: '/tv-download', name: 'tv-download', component: () => import('../views/TvDownloadView.vue') },
  { path: '/screen-recording', name: 'screen-recording', component: () => import('../views/ScreenRecordingView.vue') },
  { path: '/photopea', name: 'photopea', component: () => import('../views/PhotopeaView.vue') },
  { path: '/ip-lookup', name: 'ip-lookup', component: () => import('../views/IpLookupView.vue') },
  { path: '/id-photo', name: 'id-photo', component: () => import('../views/IdPhotoView.vue') },
  { path: '/win-update', name: 'win-update', component: () => import('../views/FakeUpdateView.vue') },
  { path: '/roll-call', name: 'roll-call', component: () => import('../views/RollCallView.vue') },
  { path: '/membership', name: 'membership', component: () => import('../views/MembershipView.vue') },
  { path: '/zip-tool', name: 'zip-tool', component: () => import('../views/ZipToolView.vue') },
  { path: '/image-upscale', name: 'image-upscale', component: () => import('../views/ImageUpscaleView.vue') },
  { path: '/stitch', name: 'stitch', component: () => import('../views/StitchView.vue') },
  { path: '/lyrics', name: 'lyrics', component: () => import('../views/LyricsView.vue') },
  { path: '/trends', name: 'trends', component: () => import('../views/TrendsView.vue') },
  { path: '/weather', name: 'weather', component: () => import('../views/WeatherView.vue') },
  { path: '/web-capture', name: 'web-capture', component: () => import('../views/WebCaptureView.vue') },
  { path: '/apex', name: 'apex', component: () => import('../views/ApexView.vue') },
  { path: '/algs', name: 'algs', component: () => import('../views/AlgsView.vue') },
  {
    path: '/github-radar',
    name: 'GitHub日报',
    component: () => import('../views/GithubRadarView.vue'),
    meta: { requiresPremium: true },
  },
  {
    path: '/admin',
    name: 'admin',
    component: () => import('../views/AdminView.vue'),
    meta: { requiresAdmin: true },
  },
]

const router = createRouter({
  history: createWebHistory(),
  routes,
})

router.beforeEach((to) => {
  const user = readCurrentUser()

  if (to.path === '/trends') {
    ElMessage.warning('热点趋势服务暂时停止')
    return { name: 'home' }
  }

  if (to.meta?.requiresAdmin) {
    if (!user) {
      ElMessage.warning('请先登录管理员账号')
      return { name: 'home' }
    }
    if (user.role !== 'admin') {
      ElMessage.warning('当前页面仅管理员可访问')
      return { name: 'home' }
    }
  }

  if (to.meta?.requiresAuth && !user) {
    ElMessage.warning('请先登录本站账号')
    return { name: 'home' }
  }

  if (to.meta?.requiresPremium) {
    if (!user) {
      ElMessage.warning('请先登录高级用户账号')
      return { name: 'home' }
    }
    if (!['admin', 'premium', 'pro'].includes(user.role)) {
      ElMessage.warning('GitHub日报仅对高级用户开放')
      return { name: 'membership' }
    }
  }

  return true
})

export default router
