#!/usr/bin/env node
import { resolve } from 'node:path';

import { prepareSemanticJobs } from '../src/prepare-semantic-jobs.mjs';

const projectRoot = resolve(process.cwd());
const result = await prepareSemanticJobs({ projectRoot });
console.log(JSON.stringify({ saved: true, file: result.file, count: result.count }, null, 2));
