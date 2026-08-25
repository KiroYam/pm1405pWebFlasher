import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
    base: '/pm1405pWebFlasher/', // replace with '/REPO_NAME/' or use '/' for root sites
    plugins: [react()]
});