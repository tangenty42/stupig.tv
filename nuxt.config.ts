import { resolve } from 'node:path'
import Aura from '@primeuix/themes/aura'
import { env } from './server/shared/env'

const alias = {
  '@shared': resolve(__dirname, './server/shared'),
  '@server': resolve(__dirname, './server'),
}

export default defineNuxtConfig({
  compatibilityDate: '2026-06-22',
  alias,

  runtimeConfig: {
    static_root: env.STATIC_ROOT,
    public: {
      api_base: env.API_BASE,
      captcha_app_id: env.CAPTCHA_APP_ID,
      color_mode_fallback: env.COLOR_MODE_FALLBACK,
      color_mode_cookie_name: env.COLOR_MODE_COOKIE_NAME,
      identity_cookie_name: env.IDENTITY_COOKIE_NAME,
      cookie_max_age: env.COOKIE_MAX_AGE_DAYS * 86400,
      max_avatar_size_mb: env.MAX_AVATAR_SIZE_MB,
      max_content_attachment_size_mb: env.MAX_CONTENT_ATTACHMENT_SIZE_MB,
      content_story_title_max_length: env.CONTENT_STORY_TITLE_MAX_LENGTH,
      content_story_label_max_bytes: env.CONTENT_STORY_LABEL_MAX_BYTES,
      content_story_desc_max_bytes: env.CONTENT_STORY_DESC_MAX_BYTES,
      content_story_cover_max_bytes: env.CONTENT_STORY_COVER_MAX_BYTES,
      content_story_markdown_max_bytes: env.CONTENT_STORY_MARKDOWN_MAX_BYTES,
      content_draft_schema_version: env.CONTENT_DRAFT_SCHEMA_VERSION,
      content_draft_storage_prefix: env.CONTENT_DRAFT_STORAGE_PREFIX,
      content_draft_autosave_delay_ms: env.CONTENT_DRAFT_AUTOSAVE_DELAY_MS,
      static_base_url: env.STATIC_BASE_URL,
      site_url: env.SITE_URL,
      mqtt_ws_host: env.MQTT_WS_HOST,
      mqtt_ws_port: env.MQTT_WS_PORT,
      mqtt_wss_port: env.MQTT_WSS_PORT,
      mqtt_qos: env.MQTT_QOS,
      mqtt_topic_prefix: env.MQTT_TOPIC_PREFIX,
      mqtt_client_id_prefix_web: env.MQTT_CLIENT_ID_PREFIX_WEB,
      timezone_cookie_name: env.TIMEZONE_COOKIE_NAME,
      auth_token_cookie_name: env.AUTH_TOKEN_COOKIE_NAME,
      auth_user_cookie_name: env.AUTH_USER_COOKIE_NAME,
      sync_broadcast_channel_name: env.SYNC_BROADCAST_CHANNEL_NAME,
      sync_client_id_storage_key: env.SYNC_CLIENT_ID_STORAGE_KEY,
      ping_idle_interval_seconds: env.PING_IDLE_INTERVAL_SECONDS,
      poll_interval_seconds: env.POLL_INTERVAL_SECONDS,
      online_timeout_seconds: env.ONLINE_TIMEOUT_SECONDS,
    },
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
    errorHandler: '/app/server/error-handler.ts',
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
  site: {
    url: env.SITE_URL,
    name: 'Stupig 蠢猪小组',
    // Production is served by a dev-mode process, so indexing can't rely on
    // NODE_ENV — it's an explicit switch.
    indexable: env.SITE_INDEXABLE,
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
    fallback: env.COLOR_MODE_FALLBACK,
    globalName: '__NUXT_COLOR_MODE__',
    componentName: 'ColorScheme',
    classPrefix: '',
    classSuffix: '',
    storage: 'cookie',
    storageKey: env.COLOR_MODE_COOKIE_NAME,
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
        { rel: 'icon', href: `${env.STATIC_BASE_URL}/imgs/Stupig_icon.svg` },
      ],
      script: [
        { src: '/sdks/ct4.js' },
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
