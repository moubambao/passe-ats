// Core of the /api/optimize endpoint, runtime-agnostic (Web Request/Response).
// Validates the input, enforces the optional access code and a per-IP rate limit,
// then streams the model's answer back as plain text.
import { buildPrompt } from './prompt.js';

const MODEL = process.env.ANTHROPIC_MODEL || 'claude-sonnet-4-5';
const MAX_CV = 20000;      // characters
const MAX_JOB = 8000;
const RATE_WINDOW_MS = 10 * 60 * 1000;
const RATE_MAX = Number(process.env.RATE_LIMIT_PER_10MIN || 6); // per IP, best effort (in-memory)
const hits = new Map();

function rateLimited(ip) {
  const now = Date.now();
  const arr = (hits.get(ip) || []).filter(t => now - t < RATE_WINDOW_MS);
  if (arr.length >= RATE_MAX) { hits.set(ip, arr); return true; }
  arr.push(now); hits.set(ip, arr);
  if (hits.size > 5000) hits.clear();
  return false;
}

function json(status, body) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' } });
}

export function configResponse() {
  return json(200, { ai: Boolean(process.env.ANTHROPIC_API_KEY), accessCode: Boolean(process.env.ACCESS_CODE), model: MODEL });
}

export async function optimizeResponse(request) {
  if (request.method !== 'POST') return json(405, { error: 'Méthode non autorisée' });
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return json(503, { error: "L'IA n'est pas configurée sur ce serveur (ANTHROPIC_API_KEY manquante)." });

  let body;
  try { body = await request.json(); } catch { return json(400, { error: 'Requête invalide' }); }
  const cv = String(body.cv || '').trim();
  const job = String(body.job || '').trim();
  if (cv.length < 80) return json(400, { error: 'Le CV est trop court pour être optimisé.' });
  if (cv.length > MAX_CV) return json(413, { error: `Le CV dépasse ${MAX_CV} caractères : raccourcissez-le.` });
  if (job.length > MAX_JOB) return json(413, { error: `L'offre dépasse ${MAX_JOB} caractères : gardez l'essentiel (missions, profil).` });

  if (process.env.ACCESS_CODE && String(body.code || '') !== process.env.ACCESS_CODE) return json(401, { error: "Code d'accès incorrect." });

  const ip = request.headers.get('x-forwarded-for')?.split(',')[0].trim() || request.headers.get('x-real-ip') || 'local';
  if (rateLimited(ip)) return json(429, { error: 'Trop de demandes depuis votre connexion : réessayez dans quelques minutes.' });

  const prompt = buildPrompt({
    cv, job,
    missing: Array.isArray(body.missing) ? body.missing.map(String) : [],
    lang: ['auto', 'fr', 'en'].includes(body.lang) ? body.lang : 'auto',
    tone: ['sobre', 'impact', 'concis'].includes(body.tone) ? body.tone : 'sobre',
  });

  let upstream;
  try {
    upstream = await fetch((process.env.ANTHROPIC_BASE_URL || 'https://api.anthropic.com') + '/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({ model: MODEL, max_tokens: 4000, temperature: 0.3, stream: true, messages: [{ role: 'user', content: prompt }] }),
      signal: request.signal,
    });
  } catch (e) {
    return json(502, { error: "Impossible de joindre le service d'IA." });
  }
  if (!upstream.ok) {
    let detail = '';
    try { detail = (await upstream.json()).error?.message || ''; } catch {}
    const status = upstream.status === 429 ? 429 : upstream.status === 401 ? 503 : 502;
    return json(status, { error: status === 429 ? "Le service d'IA est saturé : réessayez dans un instant." : status === 503 ? "Clé d'API invalide côté serveur." : `Erreur du service d'IA${detail ? ' : ' + detail : ''}.` });
  }

  // Re-stream: SSE from Anthropic -> plain text deltas to the browser.
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  let buffer = '';
  const stream = new ReadableStream({
    async start(controller) {
      const reader = upstream.body.getReader();
      try {
        while (true) {
          const { value, done } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          const events = buffer.split('\n\n');
          buffer = events.pop();
          for (const ev of events) {
            const line = ev.split('\n').find(l => l.startsWith('data:'));
            if (!line) continue;
            let data;
            try { data = JSON.parse(line.slice(5).trim()); } catch { continue; }
            if (data.type === 'content_block_delta' && data.delta?.type === 'text_delta') controller.enqueue(encoder.encode(data.delta.text));
            else if (data.type === 'error') controller.enqueue(encoder.encode('\u0000ERR' + (data.error?.message || 'Erreur du service')));
          }
        }
      } catch (e) {
        controller.enqueue(encoder.encode('\u0000ERR' + 'Flux interrompu.'));
      } finally {
        controller.close();
      }
    },
    cancel() { try { upstream.body.cancel(); } catch {} },
  });
  return new Response(stream, { headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store', 'X-Accel-Buffering': 'no' } });
}
