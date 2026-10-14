import type { MusicApi } from '../shared/contracts';

declare global {
  interface Window { music: MusicApi }
}

export {};
