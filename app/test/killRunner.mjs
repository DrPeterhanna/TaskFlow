// Loads a TypeScript child script through Vite's SSR loader (no extra dependency) so it can run as a separate OS process.
import { createServer } from 'vite';
const server = await createServer({ configFile: false, logLevel: 'silent', server: { middlewareMode: true, hmr: false, watch: null }, appType: 'custom' });
await server.ssrLoadModule(process.argv[2]);
