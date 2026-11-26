import { file_icon_names } from '~/features/content/attachments/rules'
import { alert_icons } from '~/features/content/markdown/alerts'
import { PRIVATE_ICON, REDACTION_ICON } from '~/features/content/privacy-marker'

// Every icon the rendered v-html (and its DOM wiring) can contain must be
// pre-registered: Nuxt Icon only bundles statically visible <MyIcon> usages,
// and the `i-lucide:*` spans produced at runtime are strings it never sees.
// Preview.vue forces these into the bundle via hidden <MyIcon> instances; an
// icon missing here renders blank. render.test.ts scans the renderer's
// output and asserts this list covers everything it can emit.
export const story_compiled_icons = [... new Set([
  // file_icon_names entries carry the `lucide:` prefix already.
  ... file_icon_names,
  ... Object.values(alert_icons).map(icon => `lucide:${icon}`),
  'lucide:external-link',
  // The plain link chip's leading chain icon.
  'lucide:link',
  // The carousel's prev/next buttons (added by DOM wiring, not md.render).
  'lucide:chevron-left',
  'lucide:chevron-right',
  'lucide:book-open',
  'lucide:triangle-alert',
  'lucide:image-off',
  // The folder card's leading icon.
  'lucide:folder',
  // The 机密 / 删减版 markers (<good>, cards, image brands), ban for the
  // denied placeholders.
  PRIVATE_ICON,
  REDACTION_ICON,
  'lucide:ban',
  // Loading indicator for images and embedded frames.
  'lucide:loader-circle',
])]
