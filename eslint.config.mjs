import antfu from '@antfu/eslint-config'
import localRules from './eslint.local-rules.mjs'

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
        // (`ts-non-null` is exempt: the TS non-null assertion postfix must
        // hug its operand — `obj!.foo`, not `obj !.foo`)
        '@stylistic/space-unary-ops': ['error', { words: true, nonwords: true, overrides: { 'ts-non-null': false } }],
        // Space after rest and spread operators: `... statement`
        '@stylistic/rest-spread-spacing': ['error', 'always'],
        // No padding inside template placeholders: `${statement}`
        '@stylistic/template-curly-spacing': ['error', 'never'],
      },
    },
  },
  {
    rules: {
      // Kebab-case props in templates: <tag prop-name />
      'vue/attribute-hyphenation': ['error', 'always'],
      // Keep existing block order: template / script / style
      'vue/block-order': ['error', { order: ['template', 'script', 'style'] }],
      // Match script unary spacing inside Vue template expressions
      // (the rule delegates to @stylistic/space-unary-ops; the ts-non-null
      // exemption is kept in parity with the script rule as a safeguard —
      // template TSNonNullExpression nodes are not visited by this rule today)
      'vue/space-unary-ops': ['error', { words: true, nonwords: true, overrides: { 'ts-non-null': false } }],
      // Project convention: snake_case props and emits
      'vue/prop-name-casing': 'off',
      'vue/custom-event-name-casing': 'off',
      // Short chains may stay inline or break freely (only long chains are forced)
      'antfu/consistent-chaining': 'off',
      'antfu/consistent-list-newline': 'off',
      // Node server code uses global `process` / `Buffer` idiomatically
      'node/prefer-global/process': 'off',
      'node/prefer-global/buffer': 'off',
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
  {
    plugins: {
      local: localRules,
    },
    rules: {
      'local/no-extensionless-package-subpath': 'error',
    },
  },
)
