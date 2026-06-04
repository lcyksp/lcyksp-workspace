import { createRouter, createWebHistory } from 'vue-router'
import HomeView from '../views/HomeView.vue'
import TransmitView from '../views/TransmitView.vue'
import CompressView from '../views/CompressView.vue'
import ConvertView from '../views/ConvertView.vue'
import GalleryView from '../views/GalleryView.vue'
import ReceiveView from '../views/ReceiveView.vue'
import AdminView from '../views/AdminView.vue'
import RecipeView from '../views/RecipeView.vue'

const routes = [
  { path: '/',           name: 'home',    component: HomeView },
  { path: '/transmit',   name: 'transmit', component: TransmitView },
  { path: '/transmit/:id', name: 'receive', component: ReceiveView },
  { path: '/compress',   name: 'compress', component: CompressView },
  { path: '/convert',    name: 'convert',  component: ConvertView },
  { path: '/recipe',     name: 'recipe',   component: RecipeView },
  { path: '/gallery',    name: 'gallery',  component: GalleryView },
  { path: '/admin',      name: 'admin',    component: AdminView, meta: { requiresAdmin: true } },
]

const router = createRouter({
  history: createWebHistory(),
  routes,
})

export default router
