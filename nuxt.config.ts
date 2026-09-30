import { resolve } from 'node:path'
import Aura from '@primeuix/themes/aura'
import { load_public_config } from './server/shared/config'

// 构建期没有 .env（Dockerfile/CI），而这里只需要下发到客户端的白名单，所以走
// load_public_config：不校验密钥，密钥由运行时的 load_config 负责。
const config = load_public_config()

// 客户端可见配置的白名单映射。配置本体在 config/*.yaml，schema 与类型推导在
// server/shared/config.ts；只有这里列出的字段会通过 runtimeConfig.public 下发。
const public_config = {
  api_base: config.app.api.base,
  captcha_app_id: config.aliyun.captcha.appId ?? '',
  color_mode_fallback: config.app.colorMode.fallback,
  color_mode_cookie_name: config.app.colorMode.cookieName,
  identity_cookie_name: config.app.identity.cookieName,
  cookie_max_age: config.app.auth.cookie.maxAgeDays * 86400,
  max_avatar_size_mb: config.app.avatar.maxSizeMb,
  max_content_encrypt_size_mb: config.app.content.encrypt.maxSizeMb,
  content_redact_max_dimension: config.app.content.redact.maxDimension,
  content_story_title_max_length: config.app.content.story.titleMaxLength,
  content_story_label_max_bytes: config.app.content.story.labelMaxBytes,
  content_story_desc_max_bytes: config.app.content.story.descMaxBytes,
  content_story_cover_max_bytes: config.app.content.story.coverMaxBytes,
  content_story_markdown_max_bytes: config.app.content.story.markdownMaxBytes,
  content_draft_schema_version: config.app.content.draft.schemaVersion,
  content_draft_storage_prefix: config.app.content.draft.storagePrefix,
  content_draft_autosave_delay_ms: config.app.content.draft.autosaveDelayMs,
  content_upload_handle_storage_name: config.app.content.upload.handleStorageName,
  static_base_url: config.site.staticBaseUrl,
  site_url: config.site.url,
  site_indexable: config.site.indexable,
  mqtt_ws_host: config.mqtt.web.wsHost,
  mqtt_ws_port: config.mqtt.web.wsPort,
  mqtt_wss_port: config.mqtt.web.wssPort,
  mqtt_qos: config.mqtt.qos,
  mqtt_topic_prefix: config.mqtt.topicPrefix,
  mqtt_client_id_prefix_web: config.mqtt.web.clientIdPrefix,
  timezone_cookie_name: config.app.timezone.cookieName,
  auth_user_cookie_name: config.app.auth.cookie.userName,
  sync_broadcast_channel_name: config.app.sync.broadcastChannelName,
  sync_client_id_storage_key: config.app.sync.clientIdStorageKey,
  ping_idle_interval_seconds: config.app.online.pingIdleIntervalSeconds,
  poll_interval_seconds: config.app.online.pollIntervalSeconds,
  online_timeout_seconds: config.app.online.timeoutSeconds,
}

const alias = {
  '@shared': resolve(__dirname, './server/shared'),
  '@server': resolve(__dirname, './server'),
}

// First-paint loading mask. The CSS and the markup script are inlined into the
// SSR document so the mask covers the page from the first paint until the app is
// hydrated; `app.vue` calls `window.__hide_app_loading_mask()` once mounted.
const app_loading_mask_css = `
#app-loading-mask {
  position: fixed;
  inset: 0;
  z-index: 9999;
  display: flex;
  align-items: center;
  justify-content: center;
  background-color: #ffffff;
  opacity: 1;
  animation: app-loading-mask-breath 2.6s ease-in-out infinite;
}
.dark #app-loading-mask {
  background-color: #0f172a;
}
/* The cover layer breathes: a slow, shallow opacity pulse while the page loads,
   handed over to the scripted fade-out when the app is ready. */
@keyframes app-loading-mask-breath {
  0%, 100% {
    opacity: 1;
  }
  50% {
    opacity: 0.8;
  }
}
#app-loading-mask .app-loading-mask__spinner {
  width: 3rem;
  height: 3rem;
  border: 4px solid rgb(148 163 184 / 0.3);
  border-top-color: #d96c1d;
  border-radius: 9999px;
  animation: app-loading-mask-spin 0.8s linear infinite;
}
@keyframes app-loading-mask-spin {
  to {
    transform: rotate(360deg);
  }
}
@media (prefers-reduced-motion: reduce) {
  #app-loading-mask {
    animation: none;
  }
  #app-loading-mask .app-loading-mask__spinner {
    animation-duration: 2.4s;
  }
}
`

const app_loading_mask_script = `
(function () {
  var mask_id = 'app-loading-mask'
  if (document.getElementById(mask_id)) {
    return
  }
  var mask = document.createElement('div')
  mask.id = mask_id
  mask.setAttribute('aria-hidden', 'true')
  var spinner = document.createElement('span')
  spinner.className = 'app-loading-mask__spinner'
  mask.appendChild(spinner)
  document.body.insertBefore(mask, document.body.firstChild)
  var hiding = false
  window.__hide_app_loading_mask = function () {
    if (hiding) {
      return
    }
    hiding = true
    var fade_ms = 500
    var fade = null
    // Fade from the breath animation's current opacity. Forcing opacity: 0 in
    // CSS would first snap the pulse back to its full-opacity base, so the veil
    // would flash brighter just before disappearing; fading from the live value
    // hands the running animation straight over to the fade.
    if (typeof mask.animate === 'function') {
      fade = mask.animate([{ opacity: window.getComputedStyle(mask).opacity }, { opacity: 0 }], {
        duration: fade_ms,
        easing: 'ease',
        fill: 'forwards',
      })
    }
    // Removal is timed rather than driven by the animation's finish event, so a
    // suspended animation can still never strand the mask over the page.
    window.setTimeout(function () {
      if (fade) {
        fade.cancel()
      }
      if (mask.parentNode) {
        mask.parentNode.removeChild(mask)
      }
    }, fade_ms + 50)
  }
  // Failsafe: never leave the page covered if hydration never completes.
  window.setTimeout(window.__hide_app_loading_mask, 15000)
})()
`

export default defineNuxtConfig({
  compatibilityDate: '2026-06-22',
  alias,

  runtimeConfig: {
    public: public_config,
  },

  devtools: { enabled: false },
  build: {
    transpile: ['primevue'],
  },
  postcss: {
    plugins: {
      tailwindcss: {},
      autoprefixer: {},
    },
  },
  vite: {
    build: {
      sourcemap: true,
    },
    server: {
      allowedHosts: true,
    },
    optimizeDeps: {
      include: [
        '@primevue/forms',
        'zod',
        '@primevue/forms/resolvers/zod',
        'cropperjs',
        'viewerjs',
        'mqtt',
      ],
    },
  },
  nitro: {
    // 相对路径(相对项目根)。不要写 /app/... 这类容器内绝对路径:
    // rollup 会把它按文件系统绝对路径解析,Windows 本地变成 C:\app\... 导致
    // "Cannot find module" 报错。相对路径在容器(/app)和本地都能正确解析。
    errorHandler: './server/error-handler.ts',
  },
  modules: [
    '@pinia/nuxt',
    '@primevue/nuxt-module',
    '@nuxtjs/color-mode',
    '@nuxt/icon',
    '@teages/nuxt-legacy',
    '@vueuse/nuxt',
    '@nuxtjs/sitemap',
    '@nuxtjs/robots',
  ],
  icon: {
    clientBundle: {
      // Scan bundles every icon named as a literal in source (the regex also
      // catches `lucide:*` strings inside dynamic bindings), so first-use
      // icons never fetch their CSS a roundtrip late and flash zero-width.
      // The default glob skips .ts/.js, where this project's icon literals
      // live (app/utils), so it must be extended.
      scan: {
        globInclude: ['**/*.{vue,ts,js,jsx,tsx,md,mdc,mdx,yml,yaml}'],
      },
    },
  },
  site: {
    url: public_config.site_url,
    name: 'Stupig 蠢猪小组',
    // indexable 由 config 显式声明（本地在 local.yaml 覆盖为 false），不依赖 NODE_ENV
    indexable: public_config.site_indexable,
  },
  sitemap: {
    sources: ['/api/_sitemap/urls'],
    exclude: ['/admin/**', '/content/new/**', '/content/*/edit'],
  },
  robots: {
    disallow: ['/admin', '/content/new', '/content/*/edit'],
  },
  primevue: {
    options: {
      inputVariant: 'filled',
      ripple: true,
      locale: {
        // --- Filter match modes ---
        startsWith: '开头是',
        contains: '包含',
        notContains: '不包含',
        endsWith: '结尾是',
        equals: '等于',
        notEquals: '不等于',
        noFilter: '无筛选',
        lt: '小于',
        lte: '小于等于',
        gt: '大于',
        gte: '大于等于',
        dateIs: '日期等于',
        dateIsNot: '日期不等于',
        dateBefore: '日期早于',
        dateAfter: '日期晚于',

        // --- Filter panel ---
        clear: '清除',
        apply: '应用',
        matchAll: '全部匹配',
        matchAny: '匹配任一',
        addRule: '添加规则',
        removeRule: '移除规则',

        // --- Confirmation ---
        accept: '确定',
        reject: '取消',

        // --- File upload ---
        choose: '选择',
        upload: '上传',
        cancel: '取消',
        completed: '已完成',
        pending: '等待中',

        // --- Date/Time ---
        chooseYear: '选择年份',
        chooseMonth: '选择月份',
        chooseDate: '选择日期',
        prevDecade: '上一个十年',
        nextDecade: '下一个十年',
        prevYear: '上一年',
        nextYear: '下一年',
        prevMonth: '上个月',
        nextMonth: '下个月',
        prevHour: '上一小时',
        nextHour: '下一小时',
        prevMinute: '上一分钟',
        nextMinute: '下一分钟',
        prevSecond: '上一秒',
        nextSecond: '下一秒',
        am: '上午',
        pm: '下午',
        today: '今天',
        weekHeader: '周',
        showMonthAfterYear: false,
        dateFormat: 'yy 年 m 月 d 日',

        // --- Day / Month names ---
        firstDayOfWeek: 0,
        dayNames: ['星期日', '星期一', '星期二', '星期三', '星期四', '星期五', '星期六'],
        dayNamesShort: ['周日', '周一', '周二', '周三', '周四', '周五', '周六'],
        dayNamesMin: ['日', '一', '二', '三', '四', '五', '六'],
        monthNames: ['一月', '二月', '三月', '四月', '五月', '六月', '七月', '八月', '九月', '十月', '十一月', '十二月'],
        monthNamesShort: ['一月', '二月', '三月', '四月', '五月', '六月', '七月', '八月', '九月', '十月', '十一月', '十二月'],

        // --- Password strength ---
        weak: '弱',
        medium: '中',
        strong: '强',
        passwordPrompt: '请输入密码',

        // --- Message / Search ---
        emptyFilterMessage: '无匹配结果',
        searchMessage: '找到 {0} 条结果',
        selectionMessage: '已选 {0} 条',
        emptySelectionMessage: '未选择',
        emptySearchMessage: '无匹配结果',
        emptyMessage: '暂无数据',

        // --- File ---
        fileChosenMessage: '已选择文件',
        noFileChosenMessage: '未选择文件',
        fileSizeTypes: ['B', 'KB', 'MB', 'GB', 'TB', 'PB', 'EB', 'ZB', 'YB'],

        // --- Aria labels ---
        aria: {
          trueLabel: '是',
          falseLabel: '否',
          nullLabel: '未设置',
          star: '星',
          stars: '星',
          selectAll: '全选',
          unselectAll: '取消全选',
          close: '关闭',
          previous: '上一个',
          next: '下一个',
          navigation: '导航',
          scrollTop: '回到顶部',
          moveUp: '上移',
          moveTop: '置顶',
          moveDown: '下移',
          moveBottom: '置底',
          moveToTarget: '移动到目标',
          moveToSource: '移动到来源',
          moveAllToTarget: '全部移动到目标',
          moveAllToSource: '全部移动到来源',
          pageLabel: '第 {page} 页',
          firstPageLabel: '第一页',
          lastPageLabel: '最后一页',
          nextPageLabel: '下一页',
          prevPageLabel: '上一页',
          rowsPerPageLabel: '每页条数',
          jumpToPageDropdownLabel: '跳转到页',
          jumpToPageInputLabel: '输入页码跳转',
          selectRow: '选中行',
          unselectRow: '取消选中行',
          expandRow: '展开行',
          collapseRow: '收起行',
          showFilterMenu: '显示筛选菜单',
          hideFilterMenu: '隐藏筛选菜单',
          filterOperator: '筛选运算符',
          filterConstraint: '筛选条件',
          editRow: '编辑行',
          saveEdit: '保存编辑',
          cancelEdit: '取消编辑',
          listView: '列表视图',
          gridView: '网格视图',
          slide: '幻灯片',
          slideNumber: '第 {slideNumber} 张',
          zoomImage: '缩放图片',
          zoomIn: '放大',
          zoomOut: '缩小',
          rotateRight: '向右旋转',
          rotateLeft: '向左旋转',
          listLabel: '列表',
        },
      },
      theme: {
        preset: Aura,
        options: {
          cssLayer: false,
          darkModeSelector: '.dark',
        },
      },
    },
  },
  colorMode: {
    fallback: public_config.color_mode_fallback,
    globalName: '__NUXT_COLOR_MODE__',
    componentName: 'ColorScheme',
    classPrefix: '',
    classSuffix: '',
    storage: 'cookie',
    storageKey: public_config.color_mode_cookie_name,
  },
  legacy: {
    vite: {
      targets: ['chrome >= 80'],
      modernPolyfills: true,
    },
  },
  app: {
    head: {
      title: 'Stupig 蠢猪小组 - 官方网站',
      htmlAttrs: {
        lang: 'zh-CN',
      },
      link: [
        { rel: 'icon', href: `${public_config.static_base_url}/imgs/Stupig_icon.svg` },
      ],
      style: [
        { key: 'app-loading-mask-style', textContent: app_loading_mask_css },
      ],
      script: [
        { src: '/sdks/ct4.js' },
        { key: 'app-loading-mask-script', tagPosition: 'bodyOpen', textContent: app_loading_mask_script },
      ],
    },
  },
  css: [
    'primeicons/primeicons.css',
    'viewerjs/dist/viewer.css',
    '@/assets/css/global.css',
    '@/assets/css/primevue-overrides.css',
  ],
})
