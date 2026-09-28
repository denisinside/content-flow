import tseslint from 'typescript-eslint';
import vue from 'eslint-plugin-vue';

export default tseslint.config(
  { ignores: ['**/node_modules/**', '**/dist/**', '**/generated/**', '.codex/**', '.agents/**', 'docs/**', 'coverage/**', 'test-results/**', 'playwright-report/**'] },
  ...tseslint.configs.recommended,
  ...vue.configs['flat/recommended'],
  {
    files: ['**/*.vue'],
    languageOptions: { parserOptions: { parser: tseslint.parser } },
    rules: { 'vue/multi-word-component-names': 'off' }
  },
  { rules: { '@typescript-eslint/no-explicit-any': 'error' } }
);
