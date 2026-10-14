#!/usr/bin/env node
import { startServer } from "../dist/server.mjs";
startServer().catch(() => { console.error("Knowledge service failed to start"); process.exitCode = 1; });
