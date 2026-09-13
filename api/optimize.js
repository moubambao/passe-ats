import { optimizeResponse } from '../lib/optimize.js';
export const config = { maxDuration: 60 };
export function POST(request) { return optimizeResponse(request); }
export function GET() { return new Response(JSON.stringify({ error: 'Utilisez POST' }), { status: 405, headers: { 'Content-Type': 'application/json' } }); }
