import { definePreset } from '@primeuix/themes'
import Aura from '@primeuix/themes/aura'
import defaultTheme from 'tailwindcss/defaultTheme.js'
import { border_radius } from './ui-style'

// Preserve the existing visual values while letting PrimeVue generate their
// variables for SSR, component loading and theme updates through its own API.
export const primevue_preset = definePreset(Aura, {
  components: {
    inputtext: { root: { invalidPlaceholderColor: '{inputtext.placeholder.color}' } },
    toast: {
      colorScheme: {
        light: { root: { blur: '16px' } },
        dark: { root: { blur: '16px' } },
      },
    },
    dialog: { root: { borderRadius: border_radius.sm } },
    autocomplete: {
      overlay: { borderRadius: border_radius.sm },
      option: { borderRadius: border_radius.sm },
    },
    button: {
      root: {
        borderRadius: '{button.rounded.border.radius}',
        raisedShadow: '0 1px 1px 0 rgb(0 0 0 / 0.1), 0 1px 1px -1px rgb(0 0 0 / 0.1)',
      },
    },
    paginator: {
      root: { background: 'none' },
      navButton: { selectedBackground: '{primary.500}', selectedColor: '#ffffff' },
    },
    datepicker: { buttonbar: { padding: '0.5rem 0 0.25rem 0' } },
    contextmenu: { root: { shadow: defaultTheme.boxShadow.sm }, item: { padding: '0.375rem 0.625rem' } },
    menu: { root: { shadow: defaultTheme.boxShadow.sm }, item: { padding: '0.375rem 0.625rem' } },
    togglebutton: {
      root: { borderRadius: defaultTheme.borderRadius.full },
      content: { borderRadius: defaultTheme.borderRadius.full },
    },
    selectbutton: { root: { borderRadius: defaultTheme.borderRadius.full } },
  },
})
