import type { StemApi } from '../shared/types';

declare global {
  interface Window {
    stem: StemApi;
  }
}

export {};
