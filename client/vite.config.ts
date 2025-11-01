import { defineConfig } from 'vite'
import path from 'path'
import react from '@vitejs/plugin-react'

// Infer base for GitHub Pages when building in Actions
const repo = process.env.GITHUB_REPOSITORY?.split('/')?.[1]
const isCI = !!process.env.GITHUB_ACTIONS

export default defineConfig({
  plugins: [react()],
  base: isCI && repo ? `/${repo}/` : '/',
  resolve: {
    alias: {
      '@components': path.resolve(__dirname, 'src/components'),
      '@store': path.resolve(__dirname, 'src/store'),
      '@lib': path.resolve(__dirname, 'src/lib'),
    }
  }
})
