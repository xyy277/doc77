/**
 * Minimal type declarations for packages that lack bundled .d.ts files.
 * These provide just enough typing for our usage; for full types, install
 * the corresponding @types/* package.
 */

declare module 'sql.js' {
  export interface SqlJsStatic {
    Database: new (data?: ArrayLike<number> | Buffer | null) => Database;
  }
  export interface Statement {
    bind(...params: unknown[]): void;
    step(): boolean;
    get(...params: unknown[]): unknown;
    getAsObject(): Record<string, unknown>;
    run(...params: unknown[]): { changes: number; lastInsertRowid: number | bigint };
    free(): void;
    reset(): void;
  }
  export interface Database {
    run(sql: string, params?: unknown[]): Database;
    exec(sql: string): Array<{ columns: string[]; values: unknown[][] }>;
    prepare(sql: string): Statement;
    getRowsModified(): number;
    export(): Uint8Array;
    close(): void;
  }
  const initSqlJs: (options?: { locateFile?: (file: string) => string }) => Promise<SqlJsStatic>;
  export default initSqlJs;
}

declare module 'multicast-dns' {
  interface MdnsOptions {
    multicast?: boolean;
    interface?: string;
    port?: number;
    ip?: string;
    ttl?: number;
    loopback?: boolean;
    reuseAddr?: boolean;
  }
  interface Packet {
    questions?: Array<{ name: string; type: string }>;
    answers?: Array<{ name: string; type: string; data: unknown }>;
  }
  type MdnsCallback = (packet: Packet, rinfo: { address: string; port: number }) => void;
  class MulticastDNS {
    constructor(opts?: MdnsOptions);
    on(event: 'query' | 'response' | 'ready' | 'warning', cb: MdnsCallback | ((err: Error) => void)): this;
    query(questions: unknown, cb?: () => void): void;
    respond(packet: Packet): void;
    destroy(): void;
  }
  export default function createMdns(opts?: MdnsOptions): MulticastDNS;
}
