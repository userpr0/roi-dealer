import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

/** A bank holiday as gov.uk `bank-holidays.json` lists it. */
export interface FakeBankHoliday {
  readonly title: string;
  readonly date: string;
  readonly notes?: string;
  readonly bunting?: boolean;
}

export interface FakePulseSources {
  /** Base URL to pass as `GOV_UK_URL`. */
  readonly govUkUrl: string;
  /** Base URL to pass as `WIKIMEDIA_API_URL`. */
  readonly wikimediaUrl: string;
  /** Every request path, in order. */
  readonly requests: readonly string[];
  /** The User-Agent of every Wikimedia request, in order. */
  readonly userAgents: readonly (string | undefined)[];
  /** Bank holidays per gov.uk division (`england-and-wales`, `scotland`, `northern-ireland`). */
  setBankHolidays(divisions: Readonly<Record<string, readonly FakeBankHoliday[]>>): void;
  /** Daily views per article: `{ 'Tax_return': { '2026-11-02': 120 } }`. */
  setPageviews(views: Readonly<Record<string, Readonly<Record<string, number>>>>): void;
  /** The next responses fail with this status; `undefined` restores normal answers. */
  failWith(status: number | undefined): void;
  close(): Promise<void>;
}

/**
 * Minimal gov.uk (`GET /bank-holidays.json`) and Wikimedia Analytics API
 * (`GET /metrics/pageviews/per-article/en.wikipedia/all-access/user/<article>/daily/<from>/<to>`).
 */
export async function startFakePulseSources(): Promise<FakePulseSources> {
  const requests: string[] = [];
  const userAgents: (string | undefined)[] = [];
  let holidays: Readonly<Record<string, readonly FakeBankHoliday[]>> = {};
  let views: Readonly<Record<string, Readonly<Record<string, number>>>> = {};
  let failure: number | undefined;

  const respond = (res: ServerResponse, status: number, value: unknown): void => {
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(JSON.stringify(value));
  };

  const handle = (req: IncomingMessage, res: ServerResponse): void => {
    const path = req.url ?? '';
    requests.push(path);
    if (failure !== undefined) {
      respond(res, failure, { error: 'unavailable' });
      return;
    }
    if (path === '/gov/bank-holidays.json') {
      respond(
        res,
        200,
        Object.fromEntries(
          Object.entries(holidays).map(([division, events]) => [
            division,
            {
              division,
              events: events.map((event) => ({ notes: '', bunting: true, ...event })),
            },
          ]),
        ),
      );
      return;
    }
    const match =
      /^\/wiki\/metrics\/pageviews\/per-article\/en\.wikipedia\/all-access\/user\/([^/]+)\/daily\/(\d{10})\/(\d{10})$/.exec(
        path,
      );
    if (match !== null) {
      userAgents.push(req.headers['user-agent']);
      const article = decodeURIComponent(match[1] ?? '');
      const from = match[2] ?? '';
      const to = match[3] ?? '';
      const items = Object.entries(views[article] ?? {})
        .map(([day, count]) => ({ timestamp: `${day.replaceAll('-', '')}00`, views: count }))
        .filter((item) => item.timestamp >= from && item.timestamp <= to)
        .sort((a, b) => a.timestamp.localeCompare(b.timestamp))
        .map((item) => ({
          project: 'en.wikipedia',
          article,
          granularity: 'daily',
          access: 'all-access',
          agent: 'user',
          ...item,
        }));
      if (items.length === 0) {
        respond(res, 404, { title: 'Not found.' });
        return;
      }
      respond(res, 200, { items });
      return;
    }
    respond(res, 404, { error: 'not found' });
  };

  const server = createServer(handle);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  const origin = `http://127.0.0.1:${String(port)}`;

  return {
    govUkUrl: `${origin}/gov`,
    wikimediaUrl: `${origin}/wiki`,
    requests,
    userAgents,
    setBankHolidays(divisions) {
      holidays = divisions;
    },
    setPageviews(next) {
      views = next;
    },
    failWith(status) {
      failure = status;
    },
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}
