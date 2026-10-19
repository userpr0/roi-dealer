/**
 * The api's address (ADR-0008): the build's `VITE_API_URL` when set, else the `api` parameter of
 * the page address, which the bot puts into the owner's menu button from its `PUBLIC_API_URL`.
 * The Telegram signature is sent there, so only an https address (http for localhost) with a
 * plain DNS host name and without credentials, query or fragment is used.
 */
export function apiAddress(built: string | undefined, search: string): string | undefined {
  if (built !== undefined && built.trim() !== '') return built.trim();
  const given = new URLSearchParams(search).get('api');
  if (given === null) return undefined;
  let url: URL;
  try {
    url = new URL(given);
  } catch {
    return undefined;
  }
  const local =
    url.protocol === 'http:' && (url.hostname === 'localhost' || url.hostname === '127.0.0.1');
  if (url.protocol !== 'https:' && !local) return undefined;
  if (!/^[a-z0-9-]+(\.[a-z0-9-]+)*$/.test(url.hostname)) return undefined;
  if (url.username !== '' || url.password !== '' || url.search !== '' || url.hash !== '') {
    return undefined;
  }
  return url.href.replace(/\/+$/, '');
}
