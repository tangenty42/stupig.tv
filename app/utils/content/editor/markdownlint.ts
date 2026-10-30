// string-width constructs Segmenter during module evaluation. This entry
// supplies the standard API before evaluating markdownlint's dependencies.
import '@formatjs/intl-segmenter/polyfill.js'

export { lint } from 'markdownlint/sync'
