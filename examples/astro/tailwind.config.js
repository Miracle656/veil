import { createRequire } from 'module';

const require = createRequire(import.meta.url);

export default {
  content: [
    './src/**/*.{astro,html,js,jsx,ts,tsx}',
  ],
  theme: {
    extend: {},
  },
  plugins: [],
};
