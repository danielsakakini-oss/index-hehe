// Cloudflare Pages Function for site API
// Handles the energy grid proxy and the accent map (stored in Cloudflare KV)
//
// The accent map admin password is read from the ACCENT_ADMIN_PASSWORD secret
// (Cloudflare Pages -> Settings -> Environment variables, type "Secret").
// If the secret is not set, every admin request is rejected.

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
};

function timingSafeEqual(a, b) {
  const enc = new TextEncoder();
  const x = enc.encode(a);
  const y = enc.encode(b);
  let diff = x.length ^ y.length;
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    diff |= (x[i] || 0) ^ (y[i] || 0);
  }
  return diff === 0;
}

function isAdmin(request, env) {
  const expected = env.ACCENT_ADMIN_PASSWORD;
  if (!expected) return false;
  const authHeader = request.headers.get('Authorization');
  if (!authHeader || !authHeader.startsWith('Bearer ')) return false;
  return timingSafeEqual(authHeader.substring(7), expected);
}

function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', ...corsHeaders },
  });
}

export async function onRequest(context) {
  const { request, env } = context;
  const url = new URL(request.url);
  const path = url.pathname.replace('/api/', '');

  if (request.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  // Energy grid proxy — public, key stored server-side
  if (path === 'energy' && request.method === 'GET') {
    return handleEnergy(request, env);
  }

  // Accent map — GET is public, mutations require admin
  if (path === 'accent-auth' && request.method === 'POST') {
    return isAdmin(request, env)
      ? jsonResponse({ role: 'admin' })
      : jsonResponse({ error: 'Invalid password' }, 401);
  }
  if (path === 'accent-pins' && request.method === 'GET') {
    return handleAccentPinsGet(env);
  }

  if (!isAdmin(request, env)) {
    return jsonResponse({ error: 'Unauthorized' }, 401);
  }
  const role = 'admin';

  try {
    if (path === 'accent-pins') {
      if (request.method === 'PUT') return handleAccentPinsBulkReplace(request, env, role);
      return handleAccentPinsPost(request, env, role);
    } else if (path.startsWith('accent-pins/')) {
      const id = path.split('/')[1];
      return handleAccentPin(request, env, role, id);
    }

    return jsonResponse({ error: 'Not found' }, 404);
  } catch (error) {
    console.error('API Error:', error);
    return jsonResponse({ error: error.message }, 500);
  }
}

// ============================================================
//  Energy grid proxy
// ============================================================

async function handleEnergy(request, env) {
  const apiKey = env.EIA_API_KEY;
  if (!apiKey) {
    return jsonResponse({ error: 'EIA_API_KEY not configured' }, 503);
  }

  const reqUrl = new URL(request.url);
  const region = reqUrl.searchParams.get('region') || 'US48';

  const eiaUrl = new URL('https://api.eia.gov/v2/electricity/rto/fuel-type-data/data/');
  eiaUrl.searchParams.set('api_key', apiKey);
  eiaUrl.searchParams.set('frequency', 'hourly');
  eiaUrl.searchParams.append('data[]', 'value');
  eiaUrl.searchParams.append('facets[respondent][]', region);
  eiaUrl.searchParams.append('sort[0][column]', 'period');
  eiaUrl.searchParams.append('sort[0][direction]', 'desc');
  eiaUrl.searchParams.set('length', '20');

  const resp = await fetch(eiaUrl.toString());
  const body = await resp.text();
  return new Response(body, {
    status: resp.status,
    headers: { 'Content-Type': 'application/json', ...corsHeaders },
  });
}

// ============================================================
//  Accent map handlers
// ============================================================

async function handleAccentPinsGet(env) {
  const data = await env.STEW_KV.get('accent-pins');
  const pins = data ? JSON.parse(data) : [];
  return jsonResponse(pins);
}

async function backupPins(env) {
  const existing = await env.STEW_KV.get('accent-pins');
  if (existing) await env.STEW_KV.put('accent-pins-prev', existing);
}

async function handleAccentPinsBulkReplace(request, env, role) {
  if (role !== 'admin') return jsonResponse({ error: 'Admin only' }, 403);
  const newPins = await request.json();
  if (!Array.isArray(newPins)) return jsonResponse({ error: 'Expected array' }, 400);
  await backupPins(env);
  await env.STEW_KV.put('accent-pins', JSON.stringify(newPins));
  return jsonResponse(newPins);
}

async function handleAccentPinsPost(request, env, role) {
  if (role !== 'admin') return jsonResponse({ error: 'Admin only' }, 403);
  if (request.method !== 'POST') return jsonResponse({ error: 'Method not allowed' }, 405);
  const pin = await request.json();
  const data = await env.STEW_KV.get('accent-pins');
  const pins = data ? JSON.parse(data) : [];
  await backupPins(env);
  pins.push(pin);
  await env.STEW_KV.put('accent-pins', JSON.stringify(pins));
  return jsonResponse(pin, 201);
}

async function handleAccentPin(request, env, role, id) {
  if (role !== 'admin') return jsonResponse({ error: 'Admin only' }, 403);
  const data = await env.STEW_KV.get('accent-pins');
  const pins = data ? JSON.parse(data) : [];

  if (request.method === 'PUT') {
    const updates = await request.json();
    const idx = pins.findIndex(p => p.id === id);
    if (idx === -1) return jsonResponse({ error: 'Pin not found' }, 404);
    await backupPins(env);
    pins[idx] = { ...pins[idx], ...updates };
    await env.STEW_KV.put('accent-pins', JSON.stringify(pins));
    return jsonResponse(pins[idx]);
  }

  if (request.method === 'DELETE') {
    await backupPins(env);
    const filtered = pins.filter(p => p.id !== id);
    await env.STEW_KV.put('accent-pins', JSON.stringify(filtered));
    return jsonResponse({ success: true });
  }

  return jsonResponse({ error: 'Method not allowed' }, 405);
}
