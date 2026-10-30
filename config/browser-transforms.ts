import { babel } from '@rollup/plugin-babel'

/** Preserve Unicode regex semantics before Oxc lowers literals to constructors. */
export function browser_regexp_plugin() {
  return {
    ... babel({
      babelHelpers: 'bundled',
      babelrc: false,
      configFile: false,
      extensions: ['.js', '.mjs', '.cjs'],
      plugins: ['@babel/plugin-transform-unicode-sets-regex'],
    }),
    apply: 'build' as const,
    enforce: 'pre' as const,
  }
}
