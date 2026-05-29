import { resolve } from 'path';
import { defineConfig } from 'vite';
import dts from 'vite-plugin-dts';

export default defineConfig({
    plugins: [
        dts({
            insertTypesEntry: true,
            include: ['src/**/*.ts'],
        }),
    ],
    build: {
        lib: {
            entry: resolve(__dirname, 'src/index.ts'),
            name: 'VeilInvisibleWalletVue',
            formats: ['es', 'cjs'],
            fileName: (format) => {
                if (format === 'es') return 'index.js';
                if (format === 'cjs') return 'index.cjs';
                return `index.${format}.js`;
            },
        },
        rollupOptions: {
            external: ['vue', '@stellar/stellar-sdk', 'invisible-wallet-sdk'],
            output: {
                globals: {
                    vue: 'Vue',
                    '@stellar/stellar-sdk': 'stellarSdk',
                    'invisible-wallet-sdk': 'InvisibleWalletSdk',
                },
            },
        },
    },
});
