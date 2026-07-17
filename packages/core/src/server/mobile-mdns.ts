import * as os from 'node:os';
import { VERSION } from '../version.gen.js';

export function getMobileInfo(port: number) {
  return { hostname: os.hostname(), version: VERSION, port, hasPassword: false };
}

export async function publishMdns(port: number): Promise<{ destroy: () => void } | null> {
  try {
    const multicastdns = (await import('multicast-dns')).default;
    const hostname = os.hostname().split('.')[0];
    const mdns = multicastdns();
    mdns.on('ready', () => {
      mdns.on('query', (query: any) => {
        const isOurService = query.questions?.some((q: any) => q.name === '_doc77._tcp.local' && q.type === 'PTR');
        if (!isOurService) return;
        mdns.respond({
          answers: [
            { name: '_doc77._tcp.local', type: 'PTR', data: `Doc77-${hostname}._doc77._tcp.local` },
            { name: `Doc77-${hostname}._doc77._tcp.local`, type: 'SRV', data: { priority: 10, weight: 1, port, target: os.hostname() } },
            { name: `Doc77-${hostname}._doc77._tcp.local`, type: 'TXT', data: [`version=${VERSION}`] },
            { name: `Doc77-${hostname}._doc77._tcp.local`, type: 'A', data: getLocalIP() },
          ],
        });
      });
    });
    return { destroy: () => { try { mdns.destroy(); } catch {} } };
  } catch { return null; }
}

function getLocalIP(): string {
  const ifaces = os.networkInterfaces();
  for (const name of Object.keys(ifaces)) {
    for (const iface of ifaces[name] || []) {
      if (iface.family === 'IPv4' && !iface.internal) return iface.address;
    }
  }
  return '127.0.0.1';
}
