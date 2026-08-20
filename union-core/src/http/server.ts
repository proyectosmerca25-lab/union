import http from 'node:http';
import { UnionEnv } from '../config/config.js';
import { createLogger, Logger } from '../logging/logger.js';

export interface HttpServerOptions {
  port: number;
  host?: string;
  env: UnionEnv;
  serviceVersion?: string;
  logger?: Logger;
}

export interface HttpServerHandle {
  server: http.Server;
  listen: () => Promise<number>;
  close: () => Promise<void>;
  getPort: () => number;
}

export function createHttpServer(options: HttpServerOptions): HttpServerHandle {
  const host = options.host ?? '0.0.0.0';
  const logger = options.logger ?? createLogger('http-server', { env: options.env });
  const serviceVersion = options.serviceVersion ?? '0.1.0-F1.3';

  const server = http.createServer((req, res) => {
    const path = req.url ? req.url.split('?')[0] : '/';

    if (path === '/health') {
      if (req.method === 'GET') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            status: 'ok',
            service: 'union-core',
            version: serviceVersion,
            environment: options.env
          })
        );
      } else {
        res.writeHead(405, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Method Not Allowed' }));
      }
    } else {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Not Found' }));
    }
  });

  let activePort = options.port;

  const listen = (): Promise<number> => {
    return new Promise((resolve, reject) => {
      const onError = (err: Error) => {
        logger.error('HTTP_SERVER_ERROR', {
          message: `Failed to bind HTTP server on ${host}:${options.port}: ${err.message}`,
          error: err
        });
        server.removeListener('listening', onListening);
        reject(err);
      };

      const onListening = () => {
        server.removeListener('error', onError);
        const address = server.address();
        if (address && typeof address === 'object') {
          activePort = address.port;
        }
        logger.info('HTTP_SERVER_STARTED', {
          message: `HTTP server listening on http://${host}:${activePort}/health`,
          context: { host, port: activePort }
        });
        resolve(activePort);
      };

      server.once('error', onError);
      server.once('listening', onListening);
      server.listen(options.port, host);
    });
  };

  const close = (): Promise<void> => {
    return new Promise((resolve, reject) => {
      if (!server.listening) {
        resolve();
        return;
      }

      server.close((err) => {
        if (err) {
          logger.error('HTTP_SERVER_CLOSE_ERROR', {
            message: `Error closing HTTP server: ${err.message}`,
            error: err
          });
          reject(err);
        } else {
          logger.info('HTTP_SERVER_STOPPED', {
            message: 'HTTP server stopped cleanly'
          });
          resolve();
        }
      });
    });
  };

  return {
    server,
    listen,
    close,
    getPort: () => activePort
  };
}
