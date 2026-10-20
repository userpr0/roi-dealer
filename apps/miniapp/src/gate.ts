/**
 * What the panel shows before it asks the api. Outside Telegram (no signature) nothing about
 * the setup is told: the page is public, the panel is not.
 */
export function panelGate(
  apiUrl: string | undefined,
  initData: string | undefined,
): 'outside_telegram' | 'not_configured' | undefined {
  if (initData === undefined || initData === '') return 'outside_telegram';
  if (apiUrl === undefined || apiUrl.trim() === '') return 'not_configured';
  return undefined;
}
