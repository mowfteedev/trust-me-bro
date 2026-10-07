declare module 'ws' {
  import { EventEmitter } from 'events';
  export class WebSocket extends EventEmitter {
    static OPEN: number;
    static CLOSED: number;
    readyState: number;
    send(data: any, cb?: (err?: Error) => void): void;
    close(code?: number, reason?: string): void;
    on(event: string, listener: (...args: any[]) => void): this;
  }
}
