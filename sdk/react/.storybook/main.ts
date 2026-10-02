import type { StorybookConfig } from '@storybook/react-vite';

const config: StorybookConfig = {
  stories: ['../src/**/*.stories.@(ts|tsx)'],
  addons: ['@storybook/addon-essentials'],
  framework: {
    name: '@storybook/react-vite',
    options: {},
  },
  async viteFinal(cfg) {
    // Published to a GitHub Pages subpath (…github.io/veil/), so emit relative
    // asset URLs instead of absolute /assets/… paths.
    cfg.base = './';
    return cfg;
  },
};

export default config;
