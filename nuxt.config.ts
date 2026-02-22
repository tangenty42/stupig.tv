export default defineNuxtConfig({
  compatibilityDate: '2025-07-15',
  devtools: { enabled: false },
  sourcemap: {
    server: false,
    client: false,
  },
  vite: {
    server: {
      allowedHosts: true
    }
  },
  modules: ['@nuxt/ui', '@nuxtjs/color-mode', '@nuxt/icon'],
  app: {
    head: {
      title: 'Stupig 蠢猪小组 - 官方网站',
      htmlAttrs: {
        lang: 'zh-CN',
      },
      link: [
        { rel: 'icon', type: 'image/x-icon', href: '/favicon.svg' },
      ]
    }
  },
  css: [
    '@/assets/css/global.css',
  ]
})