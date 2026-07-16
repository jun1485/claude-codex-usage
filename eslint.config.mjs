// ESLint 플랫 설정
import tseslint from 'typescript-eslint';

export default tseslint.config(
  { ignores: ['out/**', 'dist/**', 'node_modules/**', 'test/**', 'scripts/**'] },
  ...tseslint.configs.recommended,
);
