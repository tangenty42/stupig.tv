import type { Config } from 'tailwindcss'
import PrimeUI from 'tailwindcss-primeui'

export default {
  content: [
    './app/**/*.{vue,js,ts}',
    './components/**/*.{vue,js,ts}',
    './layouts/**/*.vue',
    './pages/**/*.vue',
    './plugins/**/*.{js,ts}',
    './nuxt.config.{js,ts}',
    './app.config.{js,ts}',
  ],
  darkMode: ['class'],
  theme: {
    extend: {
      borderRadius: {
        DEFAULT: '0.4rem',
        sm: '0.4rem',
        md: '0.8rem',
      },
      colors: {
        brand: {
          50: '#fdf6eb',
          100: '#fae7cb',
          200: '#f5ce9a',
          300: '#ecae61',
          400: '#e68f36',
          500: '#d96c1d',
          600: '#ba4f18',
          700: '#95391a',
          800: '#7a2f1b',
          900: '#66291a',
        },
        ocean: {
          50: '#eef7ff',
          100: '#d9eeff',
          200: '#bce0ff',
          300: '#8bc9ff',
          400: '#53a8ff',
          500: '#2c86f4',
          600: '#1d69d0',
          700: '#1853a9',
          800: '#1a478a',
          900: '#1b3c72',
        },
      },
      boxShadow: {
        float: '0 24px 60px -32px rgba(15, 23, 42, 0.45)',
      },
      fontFamily: {
        display: ['STKaiti', 'KaiTi', 'Georgia', 'serif'],
        sans: ['Source Han Sans SC', 'Noto Sans SC', 'PingFang SC', 'Microsoft YaHei', 'sans-serif'],
      },
    },
  },
  plugins: [PrimeUI],
} satisfies Config
