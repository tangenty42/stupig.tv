import antfu from '@antfu/eslint-config'

export default antfu(
  {
    vue: true,
    typescript: true,
    ignores: [
      'public/sdks/**',
      '*.tmp.mjs',
    ],
    stylistic: {
      overrides: {
        // Space after all unary operators: `! x`, `- x`, `typeof x`
        '@stylistic/space-unary-ops': ['error', { words: true, nonwords: true }],
        // No padding inside template placeholders: `${statement}`
        '@stylistic/template-curly-spacing': ['error', 'never'],
        // Break method chains only when long (4+ calls)
        '@stylistic/newline-per-chained-call': ['error', { ignoreChainWithDepth: 3 }],
      },
    },
  },
  {
    rules: {
      // Kebab-case props in templates: <tag prop-name />
      'vue/attribute-hyphenation': ['error', 'always'],
      // Keep existing block order: template / script / style
      'vue/block-order': ['error', { order: ['template', 'script', 'style'] }],
      // Project convention: snake_case props and emits
      'vue/prop-name-casing': 'off',
      'vue/custom-event-name-casing': 'off',
      // Short chains may stay inline or break freely (only long chains are forced)
      'antfu/consistent-chaining': 'off',
      'antfu/consistent-list-newline': 'off',
      // Node server code uses global `process` / `Buffer` idiomatically
      'node/prefer-global/process': 'off',
      'node/prefer-global/buffer': 'off',
      // TODO: time.test.ts has a verbatim duplicated `it` block — pending removal approval
      'test/no-identical-title': 'warn',
    },
  },
  {
    files: ['**/*.md'],
    rules: {
      // Multiple H1s are fine in docs (e.g. README sections)
      'markdown/no-multiple-h1': 'off',
    },
  },
  {
    files: ['server/**/*.ts'],
    rules: {
      // Console is the server logger
      'no-console': 'off',
    },
  },
)
