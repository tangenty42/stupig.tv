import { alert_icons } from '~/utils/content/alerts'
import { file_icon_names } from '~/utils/content/attachment'

// Every icon the rendered v-html (and its DOM wiring) can contain must be
// pre-registered: Nuxt Icon only bundles statically visible <MyIcon> usages,
// and the `i-lucide:*` spans produced at runtime are strings it never sees.
// Preview.vue forces these into the bundle via hidden <MyIcon> instances; an
// icon missing here renders blank. render.test.ts scans the renderer's
// output and asserts this list covers everything it can emit.
export const story_compiled_icons = [
  // file_icon_names entries carry the `lucide:` prefix already.
  ... file_icon_names,
  ... Object.values(alert_icons).map(icon => `lucide:${icon}`),
  'lucide:external-link',
  // The plain link chip's leading chain icon.
  'lucide:link',
  // The carousel's prev/next buttons (added by DOM wiring, not md.render).
  'lucide:chevron-left',
  'lucide:chevron-right',
  'lucide:tv',
  'lucide:play',
  'lucide:thumbs-up',
  'lucide:book-open',
  'lucide:book-x',
  // The folder card's leading icon.
  'lucide:folder',
  // The private (机密) chrome: open keyhole for permitted viewers, the closed
  // one for the 删减版 brand and its substituted card, ban for the denied
  // placeholders.
  'lucide:lock-keyhole-open',
  'lucide:lock-keyhole',
  'lucide:ban',
  // The encrypted image's 解密中 loader.
  'lucide:loader-circle',
]
