import { markdown } from '@codemirror/lang-markdown'
import { Compartment, EditorState } from '@codemirror/state'
import { EditorView } from '@codemirror/view'
import { definePreset, updatePreset } from '@primeuix/themes'
import Aura from '@primeuix/themes/aura'
import { basicSetup } from 'codemirror'
import AutoComplete from 'primevue/autocomplete'
import Button from 'primevue/button'
import PrimeVue from 'primevue/config'
import ContextMenu from 'primevue/contextmenu'
import DatePicker from 'primevue/datepicker'
import Dialog from 'primevue/dialog'
import InputText from 'primevue/inputtext'
import Menu from 'primevue/menu'
import Paginator from 'primevue/paginator'
import SelectButton from 'primevue/selectbutton'
import Toast from 'primevue/toast'
import ToastService from 'primevue/toastservice'
import ToggleButton from 'primevue/togglebutton'
import { createApp, h, nextTick, ref } from 'vue'
import { theme_extensions } from '../../../app/utils/content/editor/themes'
import { primevue_preset } from '../../../config/primevue-preset'

export interface CssOfficialProbe {
  ready: boolean
  set_dark: (dark: boolean) => Promise<void>
  set_input_radius: (radius: string) => Promise<void>
  set_compact: (compact: boolean) => Promise<void>
}

declare global {
  interface Window {
    __CSS_OFFICIAL_API_PROBE__: CssOfficialProbe
  }
}

const visible = ref(false)
const compact = ref(false)
const popup_menu = ref<InstanceType<typeof Menu>>()
const editor_theme = new Compartment()
const application_theme = document.body.dataset.theme === 'application'
const preset = application_theme
  ? primevue_preset
  : definePreset(Aura, {
      components: {
        inputtext: { root: { borderRadius: '12px' } },
        button: { root: { borderRadius: '12px' } },
      },
    })

const app = createApp({
  render: () => h('main', [
    h(InputText, { id: 'preset-input', modelValue: 'preset' }),
    h(InputText, { id: 'scoped-input', modelValue: 'scoped', dt: { root: { borderRadius: '24px' } } }),
    h(InputText, { id: 'invalid-input', invalid: true, placeholder: 'Invalid' }),
    h(Button, { id: 'preset-button', label: 'preset' }),
    h(Button, {
      id: 'utility-button',
      label: 'utility',
      class: application_theme ? '!p-0 !rounded-none w-8' : 'p-0 rounded-none w-8',
      style: { width: '123px' },
      pt: { label: { class: 'tracking-widest', style: { fontWeight: '800' } } },
    }),
    h(Button, { id: 'variant-button', label: 'Variants', class: application_theme ? '!bg-white dark:!bg-slate-900 hover:!bg-slate-200 !p-0 sm:!p-2' : 'bg-white dark:bg-slate-900 hover:bg-slate-200 p-0 sm:p-2' }),
    h(Button, { id: 'open-dialog', label: 'Open', onClick: () => visible.value = true }),
    h(Dialog, {
      'id': 'probe-dialog',
      'header': 'CSS API probe',
      'visible': visible.value,
      'onUpdate:visible': (value: boolean) => visible.value = value,
      'appendTo': 'body',
      'class': application_theme ? 'w-64' : 'rounded-none w-64',
      'style': { width: '321px' },
      'pt': { content: { 'class': application_theme ? compact.value ? '!p-0' : '!p-4' : compact.value ? 'p-0' : 'p-4', 'data-testid': 'dialog-content' } },
    }, { default: () => 'Teleported content' }),
    application_theme
      ? h('section', { id: 'theme-controls' }, [
          h(AutoComplete, { id: 'autocomplete-probe', suggestions: [], dropdown: true }),
          h(ToggleButton, { id: 'toggle-probe', modelValue: false, onLabel: 'On', offLabel: 'Off' }),
          h(SelectButton, { id: 'select-probe', modelValue: 'One', options: ['One', 'Two'] }),
          h(Paginator, { id: 'paginator-probe', rows: 10, totalRecords: 50 }),
          h(DatePicker, { id: 'datepicker-probe', showButtonBar: true }),
          h(Button, { id: 'open-menu', label: 'Menu', onClick: (event: Event) => popup_menu.value?.toggle(event) }),
          h(Menu, { id: 'menu-probe', ref: popup_menu, popup: true, model: [{ label: 'Entry' }] }),
          h(ContextMenu, { id: 'contextmenu-probe', model: [{ label: 'Entry' }] }),
          h(Toast),
        ])
      : null,
    h('div', { id: 'project-editor' }),
    h('div', { id: 'conflict-editor' }),
    h('div', { id: 'id-conflict', class: 'text-red-500' }, 'ID boundary'),
    h('div', { id: 'important-conflict', class: 'text-red-500 importance-probe' }, 'important boundary'),
  ]),
})

app.use(PrimeVue, { theme: { preset, options: { cssLayer: false, darkModeSelector: '.dark' } } })
app.use(ToastService)
app.mount('#__nuxt')

const project_editor = new EditorView({
  parent: document.querySelector('#project-editor')!,
  state: EditorState.create({
    doc: '# Heading\n\nText',
    extensions: [basicSetup, markdown(), editor_theme.of(theme_extensions('light'))],
  }),
})

const conflict_editor = new EditorView({
  parent: document.querySelector('#conflict-editor')!,
  state: EditorState.create({
    doc: 'Utility versus theme',
    extensions: [
      basicSetup,
      EditorView.theme({ '.cm-content': { color: 'rgb(25, 50, 75)' } }),
      EditorView.contentAttributes.of({ class: application_theme ? '!text-red-500' : 'text-red-500' }),
    ],
  }),
})

window.addEventListener('pagehide', () => {
  project_editor.destroy()
  conflict_editor.destroy()
  app.unmount()
}, { once: true })

window.__CSS_OFFICIAL_API_PROBE__ = {
  ready: false,
  async set_dark(dark) {
    document.documentElement.classList.toggle('dark', dark)
    project_editor.dispatch({ effects: editor_theme.reconfigure(theme_extensions(dark ? 'dark' : 'light')) })
    await nextTick()
  },
  async set_input_radius(radius) {
    updatePreset({ components: { inputtext: { root: { borderRadius: radius } } } })
    await nextTick()
  },
  async set_compact(value) {
    compact.value = value
    await nextTick()
  },
}

nextTick(() => window.__CSS_OFFICIAL_API_PROBE__.ready = true)
