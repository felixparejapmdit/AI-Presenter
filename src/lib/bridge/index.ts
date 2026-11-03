import { createTauriBridge } from './tauriBridge';
import { createWebBridge } from './webBridge';
import type { Bridge } from './types';

export const isTauri = typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;

export const bridge: Bridge = isTauri ? createTauriBridge() : createWebBridge();

export type { Bridge } from './types';
