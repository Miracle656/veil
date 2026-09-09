/** Minimal Babel config for Jest to transform ESM-only packages to CJS. */
module.exports = {
  presets: [
    ['@babel/preset-env', { targets: { node: 'current' }, modules: 'commonjs' }],
  ],
};
