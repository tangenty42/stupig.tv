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
    files: ['**/*.{yaml,yml}'],
    rules: {
      'yml/block-mapping': ['error', 'always'],
      'yml/block-sequence': ['error', 'always'],
      '@stylistic/eol-last': ['error', 'always'],
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
    files: ['**/*.?([cm])js'],
    rules: {
      // eslint-plugin-unused-imports@4.4.1 resolves no-unused-vars to the
      // @typescript-eslint rule whenever that package is present, and the TS
      // rule misreads plain espree scopes: every local binding in a JS file is
      // reported as "only used as a type" (false positive). Plain JS files use
      // the base rule with the same options; TS files keep the plugin rule.
      'no-unused-vars': ['error', { args: 'after-used', argsIgnorePattern: '^_', ignoreRestSiblings: true, vars: 'all', varsIgnorePattern: '^_' }],
      'unused-imports/no-unused-vars': 'off',
      // The base rule already flags unused imports in JS files; without this
      // they would be reported twice.
      'unused-imports/no-unused-imports': 'off',
    },
  },
  {
    files: ['pnpm-workspace.yaml'],
    rules: {
      // antfu enforces trustPolicy: no-downgrade and minimumReleaseAgeExcludePrune
      // on top of these; both are deliberately unset (see the comment in
      // pnpm-workspace.yaml — no-downgrade blocks well-attested packages, and
      // ExcludePrune only cleans minimumReleaseAgeExclude, which we don't use).
      'pnpm/yaml-enforce-settings': ['error', {
        settings: {
          minimumReleaseAge: 1440,
          shellEmulator: true,
        },
      }],
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
