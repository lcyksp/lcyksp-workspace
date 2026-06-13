import { createRouter, createWebHistory } from 'vue-router'
import { ElMessage } from 'element-plus'
import HomePageView from '../views/HomePageView.vue'
import TransmitView from '../views/TransmitView.vue'
import CompressView from '../views/CompressView.vue'
import ConvertView from '../views/ConvertView.vue'
import GalleryView from '../views/GalleryView.vue'
import ReceiveView from '../views/ReceiveView.vue'
import AdminView from '../views/AdminView.vue'
import RecipeView from '../views/RecipeView.vue'
import PixelArtView from '../views/PixelArtConverter.vue'
import ObfuscateView from '../views/ObfuscateView.vue'
import PdfMergeView from '../views/PdfMergeView.vue'
import PdfSplitView from '../views/PdfSplitView.vue'
import ImgToPdfView from '../views/ImgToPdfView.vue'
import PdfToImgView from '../views/PdfToImgView.vue'
import PdfExtractTextView from '../views/PdfExtractTextView.vue'
import PdfPageEditorView from '../views/PdfPageEditorView.vue'
import PdfWatermarkView from '../views/PdfWatermarkView.vue'
import PdfSignView from '../views/PdfSignView.vue'
import VideoDownloadView from '../views/VideoDownloadView.vue'
import MembershipView from '../views/MembershipView.vue'

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
  { path: '/transmit', name: 'transmit', component: TransmitView },
  { path: '/transmit/:id', name: 'receive', component: ReceiveView },
  { path: '/compress', name: 'compress', component: CompressView },
  { path: '/convert', name: 'convert', component: ConvertView },
  { path: '/recipe', name: 'recipe', component: RecipeView },
  { path: '/gallery', name: 'gallery', component: GalleryView },
  { path: '/pixel-art', name: 'pixel-art', component: PixelArtView },
  { path: '/obfuscate', name: 'obfuscate', component: ObfuscateView },
  { path: '/pdf-merge', name: 'pdf-merge', component: PdfMergeView },
  { path: '/pdf-split', name: 'pdf-split', component: PdfSplitView },
  { path: '/img-to-pdf', name: 'img-to-pdf', component: ImgToPdfView },
  { path: '/pdf-to-img', name: 'pdf-to-img', component: PdfToImgView },
  { path: '/pdf-extract-text', name: 'pdf-extract-text', component: PdfExtractTextView },
  { path: '/pdf-page-editor', name: 'pdf-page-editor', component: PdfPageEditorView },
  { path: '/pdf-watermark', name: 'pdf-watermark', component: PdfWatermarkView },
  { path: '/pdf-sign', name: 'pdf-sign', component: PdfSignView },
  { path: '/video-download', name: 'video-download', component: VideoDownloadView },
  { path: '/membership', name: 'membership', component: MembershipView },
  { path: '/admin', name: 'admin', component: AdminView, meta: { requiresAdmin: true } },
]

const router = createRouter({
  history: createWebHistory(),
  routes,
})

router.beforeEach((to) => {
  const user = readCurrentUser()

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

  return true
})

export default router
