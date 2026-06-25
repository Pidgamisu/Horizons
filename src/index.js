import { createServer } from './server.js';

const PORT = process.env.PORT ? parseInt(process.env.PORT) : 8080;
createServer(PORT);
