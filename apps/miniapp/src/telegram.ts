/*
 * The part of Telegram's Mini App script (telegram-web-app.js, loaded in index.html) the panel
 * uses: the signed `initData` for the API and the ready/expand calls.
 */

interface TelegramWebApp {
  /** Signed by Telegram for the bot; empty when the page is opened outside Telegram. */
  readonly initData: string;
  ready(): void;
  expand(): void;
}

declare global {
  interface Window {
    readonly Telegram?: { readonly WebApp?: TelegramWebApp };
  }

  interface ImportMetaEnv {
    /** The api service's public address, set at build time (GitHub variable MINIAPP_API_URL). */
    readonly VITE_API_URL?: string;
  }
}

export function telegramApp(): TelegramWebApp | undefined {
  return window.Telegram?.WebApp;
}
