/**
 * The short commit this build was made from ('abc1234'), or 'dev'. Vite
 * writes the value in at build time (vite.config.ts); under vitest nothing
 * does, and the typeof keeps that from throwing.
 */
export const APP_VERSION: string =
  typeof __APP_VERSION__ === 'string' ? __APP_VERSION__ : 'dev'
