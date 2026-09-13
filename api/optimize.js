import { optimizeResponse } from '../lib/optimize.js';
export const config = { maxDuration: 60 };
export default function handler(request) { return optimizeResponse(request); }
